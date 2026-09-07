import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "@/lib/store/db";
import { relayOutbox } from "@/lib/webhooks/relay";

/**
 * Watching an item, end to end through the relay.
 *
 * Every claim here is a recipient claim, which is why none of them can be made
 * without a database: who hears about a change comes out of the tree, the
 * roster and the watch rows together.
 *
 * The two that carry the design are the mute and the cascade. A mute has to
 * outrank being the assignee, or "stop telling me about this one item" would
 * mean giving the work away. A cascade has to reach down only when it asked
 * to, or watching an initiative would put every status change beneath it in
 * one inbox, which is the flood this release exists to prevent.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const ws = randomUUID();
const user = {
  alice: randomUUID(), // the actor
  bob: randomUUID(),
  carol: randomUUID(),
};
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asAlice = { userId: user.alice, workspaceId: ws };
const asBob = { userId: user.bob, workspaceId: ws };
const asCarol = { userId: user.carol, workspaceId: ws };

interface InboxRow {
  recipient_id: string;
  type: string;
}

describe.skipIf(!OWNER_URL)("watching an item", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);

    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'Watch', ${"watch-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${suffix}@watch.test`}),
      (${user.bob}, 'Bob', ${`bob-${suffix}@watch.test`}),
      (${user.carol}, 'Carol', ${`carol-${suffix}@watch.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.alice}, 'owner'),
      (${ws}, ${user.bob}, 'member'),
      (${ws}, ${user.carol}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${user.alice}, ${user.bob}, ${user.carol})`;
    await owner.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await owner`delete from notifications where workspace_id = ${ws}`;
    await owner`delete from item_watchers where workspace_id = ${ws}`;
    await owner`delete from features where workspace_id = ${ws}`;
    await owner`delete from outbox_events where workspace_id = ${ws}`;
  });

  /** Run the relay and read back what landed. */
  async function drain(): Promise<InboxRow[]> {
    await relayOutbox();
    return owner<InboxRow[]>`
      select recipient_id, type from notifications
      where workspace_id = ${ws} order by created_at, type`;
  }

  function newItem(over: Record<string, unknown> = {}) {
    return store.createFeature(
      { title: "Checkout flow", level: "story", productId: product, ...over },
      asAlice,
      "item.created",
    );
  }

  /** Move an item's status, emitting the event the relay reads. */
  async function moveStatus(specId: string, title: string, from: string) {
    await store.updateFeature(specId, { status: "in_progress" }, asAlice, [
      {
        type: "item.status_changed",
        productId: product,
        data: { specId, title, from, to: "in_progress" },
      },
    ]);
  }

  it("tells a watcher about an item that is not theirs", async () => {
    // The gap this feature closes: before it, interest could only be inferred
    // from the data, so caring about somebody else's item was unsayable.
    const item = await newItem();
    await store.setWatch(item.specId, { watching: true }, asBob);
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await moveStatus(item.specId, item.title, item.status);
    const rows = await drain();
    expect(rows).toEqual([
      { recipient_id: user.bob, type: "item.status_changed" },
    ]);
  });

  it("stops telling the assignee once they unwatch, and leaves them assigned", async () => {
    const item = await newItem({ assigneeId: user.bob });
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    // Still assigned before the mute: this is the baseline the next assertion
    // is measured against.
    await moveStatus(item.specId, item.title, item.status);
    expect(await drain()).toHaveLength(1);
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.setWatch(item.specId, { watching: false }, asBob);
    await store.updateFeature(item.specId, { status: "in_review" }, asAlice, [
      {
        type: "item.status_changed",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          from: "in_progress",
          to: "in_review",
        },
      },
    ]);
    expect(await drain()).toEqual([]);

    const [row] = await owner`
      select assignee_id from features where spec_id = ${item.specId}`;
    expect(row!.assignee_id).toBe(user.bob);
  });

  it("keeps a cascading watch on the parent reaching its children", async () => {
    const epic = await store.createFeature(
      { title: "Checkout", level: "epic", productId: product },
      asAlice,
      "item.created",
    );
    const child = await newItem({ parentSpecId: epic.specId });
    await store.setWatch(
      epic.specId,
      { watching: true, includeDescendants: true },
      asCarol,
    );
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await moveStatus(child.specId, child.title, child.status);
    const rows = await drain();
    expect(rows).toEqual([
      { recipient_id: user.carol, type: "item.status_changed" },
    ]);
  });

  it("keeps a plain watch on the parent off its children", async () => {
    // The other half of the same decision. Cascade is a choice per watch, so
    // watching an epic must not quietly enrol somebody in everything under it.
    const epic = await store.createFeature(
      { title: "Checkout", level: "epic", productId: product },
      asAlice,
      "item.created",
    );
    const child = await newItem({ parentSpecId: epic.specId });
    await store.setWatch(
      epic.specId,
      { watching: true, includeDescendants: false },
      asCarol,
    );
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await moveStatus(child.specId, child.title, child.status);
    expect(await drain()).toEqual([]);
  });

  it("auto-watches the person an item was handed to", async () => {
    const item = await newItem();
    await store.updateFeature(item.specId, { assigneeId: user.bob }, asAlice, [
      {
        type: "item.assigned",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.bob,
          previousAssigneeId: null,
        },
      },
    ]);
    await drain();

    const state = await store.listWatchers(item.specId, asBob);
    expect(state.watching).toBe(true);
    expect(state.explicit).toBe(true);
    expect(state.watchers.map((w) => w.userId)).toContain(user.bob);
    expect(state.watchers.find((w) => w.userId === user.bob)?.source).toBe("auto");
  });

  it("does not let auto-watch put back somebody who left", async () => {
    // Auto-watch that could not be left would be noise with extra steps. The
    // insert is ON CONFLICT DO NOTHING precisely so a row saying no survives
    // every later reason the system has to add somebody.
    const item = await newItem();
    await store.setWatch(item.specId, { watching: false }, asBob);

    await store.updateFeature(item.specId, { assigneeId: user.bob }, asAlice, [
      {
        type: "item.assigned",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.bob,
          previousAssigneeId: null,
        },
      },
    ]);
    await drain();

    const state = await store.listWatchers(item.specId, asBob);
    expect(state.watching).toBe(false);
    expect(state.watchers.map((w) => w.userId)).not.toContain(user.bob);
  });

  it("reads the assignee as watching before they have said anything", async () => {
    const item = await newItem({ assigneeId: user.bob });
    const state = await store.listWatchers(item.specId, asBob);
    // Effective, not stored: nothing has been written for Bob yet, and the
    // control has to say so rather than claiming he chose it.
    expect(state).toMatchObject({ watching: true, explicit: false });
  });

  it("shows the watcher list to another member of the workspace", async () => {
    // Visible watchers, which is the answer to the card's open question: a
    // count nobody can see does not tell an author that anyone is listening.
    const item = await newItem();
    await store.setWatch(item.specId, { watching: true }, asBob);

    const seenByCarol = await store.listWatchers(item.specId, asCarol);
    expect(seenByCarol.watchers.map((w) => w.userId)).toEqual([user.bob]);
    expect(seenByCarol.watching).toBe(false);
  });

  it("refuses one member writing another member's watch", async () => {
    // The store offers no argument for whose watch to set, so this goes at the
    // database directly, as the app role, to check the backstop rather than
    // the API shape. A member able to insert somebody else's row could
    // subscribe a colleague to an item they never asked about, and the
    // notification would look like the product's doing rather than theirs.
    const item = await newItem();
    const [feature] = await owner`
      select id from features where spec_id = ${item.specId}`;

    const app = postgres(appUrlFrom(OWNER_URL!), { prepare: false, max: 1 });
    try {
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${user.bob}, true)`;
          await tx`
            insert into item_watchers (workspace_id, feature_id, user_id, watching)
            values (${ws}, ${feature!.id}, ${user.carol}, true)`;
        }),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await app.end({ timeout: 5 });
    }

    const rows = await owner`
      select user_id from item_watchers where workspace_id = ${ws}`;
    expect(rows).toEqual([]);
  });

  it("counts a watcher once, however many reasons they have", async () => {
    const item = await newItem({ assigneeId: user.bob });
    await store.setWatch(item.specId, { watching: true }, asBob);
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await moveStatus(item.specId, item.title, item.status);
    const rows = await drain();
    expect(rows).toHaveLength(1);
  });
});
