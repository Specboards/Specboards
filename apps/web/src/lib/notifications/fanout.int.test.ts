import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "@/lib/store/db";
import { relayOutbox } from "@/lib/webhooks/relay";

/**
 * Who gets told, against a migrated Postgres.
 *
 * The fan-out is the piece that decides whether this feature is useful or
 * unbearable, and every failure mode is a recipient question rather than a
 * write question: told twice, told about your own click, told after you left
 * the workspace, told once per item in a release instead of once. None of that
 * is visible in a unit test of the resolution functions, because the answers
 * come out of the database (who is assigned, who is still a member, what is in
 * the release).
 *
 * Driven through the real relay rather than by calling the fan-out directly,
 * so the claim that matters is actually covered: an event is expanded once,
 * inside the transaction that stamps it processed.
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
  alice: randomUUID(), // the actor in most of these
  bob: randomUUID(),
  carol: randomUUID(),
  dana: randomUUID(), // deactivated
};
const product = randomUUID();
/** A private product Bob is not a member of, to prove he is never told about
 * work he cannot open. */
const closedProduct = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asAlice = { userId: user.alice, workspaceId: ws };

interface InboxRow {
  recipient_id: string;
  type: string;
  snippet: string;
  actor_id: string | null;
  comment_id: string | null;
}

describe.skipIf(!OWNER_URL)("notification fan-out", () => {
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
      (${ws}, 'Fanout', ${"fanout-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${suffix}@fanout.test`}),
      (${user.bob}, 'Bob', ${`bob-${suffix}@fanout.test`}),
      (${user.carol}, 'Carol', ${`carol-${suffix}@fanout.test`}),
      (${user.dana}, 'Dana', ${`dana-${suffix}@fanout.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.alice}, 'owner'),
      (${ws}, ${user.bob}, 'member'),
      (${ws}, ${user.carol}, 'member')`;
    // Dana has left. Still a row, so a stale recipient list would still find
    // her; the fan-out has to notice the deactivation.
    await owner`insert into members (workspace_id, user_id, role, deactivated_at)
      values (${ws}, ${user.dana}, 'member', now())`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    // Private, and Carol is its only member. Alice reaches it as the workspace
    // owner; Bob cannot reach it at all.
    await owner`insert into products (id, workspace_id, key, name, visibility) values
      (${closedProduct}, ${ws}, 'closed', 'Closed', 'private')`;
    await owner`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${closedProduct}, ${user.carol}, 'contributor')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${user.alice}, ${user.bob}, ${user.carol}, ${user.dana})`;
    await owner.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await owner`delete from notifications where workspace_id = ${ws}`;
    await owner`delete from notification_defaults where workspace_id = ${ws}`;
    await owner`delete from notification_preferences where workspace_id = ${ws}`;
  });

  /**
   * Run the relay, then answer both halves of "who was told": what the fan-out
   * WROTE, and what each recipient can actually READ.
   *
   * Returns the written rows, so every assertion below is unchanged. The read
   * is checked here rather than asserted per test, because it is the same claim
   * every time and it was the half this suite could not see: seventeen tests
   * proved the fan-out wrote the right rows for the right people, and not one
   * of them proved those people could read them.
   *
   * That is the more likely half to break. Rows are written by
   * `specboards_worker` under a permissive `notifications_worker_all`, and read
   * by `specboards_app` under `notifications_read`, which wants
   * `specboards_is_member` and a matching `app.user_id`, and then inner-joins
   * `features`, which carries its own `specboards_can_read_product`. A
   * recipient who cannot see the item's product loses the notification with no
   * error anywhere, because `fanOutNotifications` swallows its own.
   *
   * ── Why the write is still read on the owner connection ────────────────────
   * The "tells nobody" assertions need to tell "the fan-out wrote no row" from
   * "a row exists and the policy hides it", and only a reader that bypasses RLS
   * can. The deactivated-member case is the sharpest: `specboards_is_member`
   * requires `deactivated_at is null`, so Dana can never read anything whatever
   * the fan-out did, and a test asserting she hears nothing would pass on a
   * fan-out that wrongly told her. Comparing the two is what makes both
   * questions answerable at once: a row written and not readable fails here,
   * and so does a row readable that should never have been written.
   */
  async function drain(): Promise<InboxRow[]> {
    await relayOutbox();
    const written = await owner<InboxRow[]>`
      select recipient_id, type, snippet, actor_id, comment_id
      from notifications
      where workspace_id = ${ws}
      order by created_at, type`;

    // Asked once per person, because the inbox is per recipient by
    // construction: there is no query that returns everybody's, which is the
    // point of the policy.
    const readable: InboxRow[] = [];
    for (const recipientId of Object.values(user)) {
      const inbox = await store.listNotifications({
        userId: recipientId,
        workspaceId: ws,
      });
      for (const n of inbox.items) {
        readable.push({
          recipient_id: recipientId,
          type: n.type,
          snippet: n.snippet,
          actor_id: n.actorId,
          comment_id: n.commentId,
        });
      }
    }

    expect(canonical(readable), "the recipients cannot read what the fan-out wrote").toEqual(
      canonical(written),
    );
    return written;
  }

  /** Order-free comparable form: the two readers sort differently on purpose
   * (oldest-first for the ledger, newest-first for an inbox), and the claim is
   * about which rows exist for whom, not their order. */
  function canonical(rows: readonly InboxRow[]): string[] {
    return rows
      .map((r) =>
        [r.recipient_id, r.type, r.snippet, r.actor_id, r.comment_id].join("\u0000"),
      )
      .sort();
  }

  function newItem(over: Record<string, unknown> = {}) {
    return store.createFeature(
      { title: "Checkout flow", level: "story", productId: product, ...over },
      asAlice,
      "item.created",
    );
  }

  it("tells the person an item was handed to", async () => {
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

    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.bob,
      type: "item.assigned",
      actor_id: user.alice,
    });
    // The headline says only "assigned you an item"; without the title in the
    // snippet the row does not say which one.
    expect(rows[0]!.snippet).toContain("Checkout flow");
  });

  it("tells nobody when you assign an item to yourself", async () => {
    const item = await newItem();
    await store.updateFeature(
      item.specId,
      { assigneeId: user.alice },
      asAlice,
      [
        {
          type: "item.assigned",
          productId: product,
          data: {
            specId: item.specId,
            title: item.title,
            level: item.level,
            assigneeId: user.alice,
            previousAssigneeId: null,
          },
        },
      ],
    );

    expect(await drain()).toEqual([]);
  });

  it("tells nobody about an item handed to somebody who has left", async () => {
    // The membership row still exists, deactivated. A recipient list built from
    // the item alone would keep mailing her.
    const item = await newItem();
    await store.updateFeature(item.specId, { assigneeId: user.dana }, asAlice, [
      {
        type: "item.assigned",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.dana,
          previousAssigneeId: null,
        },
      },
    ]);

    expect(await drain()).toEqual([]);
  });

  it("tells the assignee when their item moves stage", async () => {
    const item = await newItem({ assigneeId: user.bob });
    await drain(); // clear the assignment raised by the create
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.updateFeature(item.specId, { status: "defining" }, asAlice, [
      {
        type: "item.status_changed",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          from: item.status,
          to: "defining",
        },
      },
    ]);

    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.bob,
      type: "item.status_changed",
    });
    expect(rows[0]!.snippet).toContain("defining");
  });

  it("tells the person a card is created for, not just the person who made it", async () => {
    // Creating a card already assigned to somebody is how work is handed over.
    await newItem({ assigneeId: user.bob });

    const rows = await drain();
    expect(rows.map((r) => r.type)).toEqual(["item.assigned"]);
    expect(rows[0]!.recipient_id).toBe(user.bob);
  });

  it("separates being named in a comment from being kept in the loop", async () => {
    const item = await newItem({ assigneeId: user.carol });
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.createComment(
      item.specId,
      { body: "@Bob can you look at this?", mentionedUserIds: [user.bob] },
      asAlice,
    );

    const rows = await drain();
    // Bob was spoken to; Carol owns the item and is being kept informed. They
    // are tuned separately in preferences, so they must not arrive as one type.
    expect(
      rows
        .map((r) => ({ who: r.recipient_id, type: r.type }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual([
      { who: user.carol, type: "comment.created" },
      { who: user.bob, type: "comment.mentioned" },
    ]);
    // Both point at the comment, so the inbox can deep-link to it.
    expect(rows.every((r) => r.comment_id !== null)).toBe(true);
  });

  it("never sends the quieter comment notice to somebody it already mentioned", async () => {
    // Bob is both the assignee and the person named. One notice, the louder one.
    const item = await newItem({ assigneeId: user.bob });
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.createComment(
      item.specId,
      { body: "@Bob thoughts?", mentionedUserIds: [user.bob] },
      asAlice,
    );

    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("comment.mentioned");
  });

  it("ignores a mention of somebody outside the workspace", async () => {
    // A user id that is not a member at all, as opposed to one who has left.
    // Both have to be dropped, and only the membership query can tell either.
    const stranger = randomUUID();
    const item = await newItem();
    await store.createComment(
      item.specId,
      { body: "@Nobody hello", mentionedUserIds: [stranger] },
      asAlice,
    );

    expect(await drain()).toEqual([]);
  });

  it("tells nobody about a comment on an item nobody owns", async () => {
    const item = await newItem();
    await store.createComment(
      item.specId,
      { body: "Thinking out loud." },
      asAlice,
    );
    expect(await drain()).toEqual([]);
  });

  it("rolls a new child up to whoever owns the parent", async () => {
    const parent = await store.createFeature(
      {
        title: "Checkout",
        level: "epic",
        productId: product,
        assigneeId: user.bob,
      },
      asAlice,
      "item.created",
    );
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await newItem({ title: "Card payments", parentSpecId: parent.specId });

    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.bob,
      type: "item.created",
    });
    expect(rows[0]!.snippet).toContain("Card payments");
    expect(rows[0]!.snippet).toContain("Checkout");
  });

  it("says nothing when an item is created with no parent to roll up to", async () => {
    await newItem();
    expect(await drain()).toEqual([]);
  });

  it("tells each person once that a release shipped, however many items they had", async () => {
    const release = randomUUID();
    await owner`insert into releases (id, workspace_id, product_id, name, status)
      values (${release}, ${ws}, ${product}, 'v9.9.9', 'planned')`;
    const first = await newItem({ title: "One", assigneeId: user.bob });
    const second = await newItem({ title: "Two", assigneeId: user.bob });
    await owner`update features set release_id = ${release}
      where spec_id in (${first.specId}, ${second.specId})`;
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.updateRelease(release, { status: "shipped" }, asAlice, {
      type: "release.shipped",
      productId: product,
      data: { releaseId: release, name: "v9.9.9", itemCount: 2 },
    });

    const rows = await drain();
    // Two items, one person, one notice. Per-item rows would make shipping a
    // release the single noisiest thing the product can do.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.bob,
      type: "release.shipped",
    });
    expect(rows[0]!.snippet).toContain("2 of your items");
  });

  it("raises nothing for a deleted item, whose inbox row could not survive it", async () => {
    // `notifications.feature_id` is NOT NULL and cascades, so a notice about a
    // deleted item cannot exist. The event still has to be processed, not stuck.
    const item = await newItem({ assigneeId: user.bob });
    await drain();
    await owner`delete from notifications where workspace_id = ${ws}`;

    await store.deleteFeature(item.specId, asAlice, {
      type: "item.deleted",
      productId: product,
      data: { specId: item.specId, title: item.title, level: item.level },
    });

    expect(await drain()).toEqual([]);
    const [pending] = await owner`
      select count(*)::int as n from outbox_events
      where workspace_id = ${ws} and processed_at is null`;
    expect(pending!.n).toBe(0);
  });

  /**
   * Being in the workspace is not being able to see the item.
   *
   * The in-app half of this failed silently: the row was written and then
   * hidden, because the inbox inner-joins `features` and that carries
   * `specboards_can_read_product`. The email half did not fail at all, which is
   * worse: a real message, a deep link the reader 404s on, and a subject line
   * carrying the title of work in a product they were deliberately not given
   * access to.
   */
  it("tells nobody about an item in a product they cannot read", async () => {
    const item = await store.createFeature(
      { title: "Secret roadmap", level: "story", productId: closedProduct },
      asAlice,
      "item.created",
    );
    await store.updateFeature(item.specId, { assigneeId: user.bob }, asAlice, [
      {
        type: "item.assigned",
        productId: closedProduct,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.bob,
          previousAssigneeId: null,
        },
      },
    ]);

    expect(await drain()).toEqual([]);
  });

  it("still tells a member of that product", async () => {
    const item = await store.createFeature(
      { title: "Secret roadmap", level: "story", productId: closedProduct },
      asAlice,
      "item.created",
    );
    await store.updateFeature(item.specId, { assigneeId: user.carol }, asAlice, [
      {
        type: "item.assigned",
        productId: closedProduct,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.carol,
          previousAssigneeId: null,
        },
      },
    ]);

    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.carol,
      type: "item.assigned",
    });
  });

  it("expands an event once, however often the relay runs", async () => {
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
    const rows = await drain();
    // The `processedAt` stamp commits with the rows, so a second sweep finds
    // nothing to expand. A duplicate here would mean every restart re-notified.
    expect(rows).toHaveLength(1);
  });

  /**
   * Preferences, seen from the only place they matter.
   *
   * The settings suite proves the rows resolve; these prove the relay asks.
   * They are the same claim the settings screen makes, checked at the far end
   * of the pipe: what somebody switches off has to actually stop arriving, and
   * a workspace default has to reach the people who have not overridden it and
   * nobody else.
   */
  async function assign(to: string) {
    const item = await newItem();
    await store.updateFeature(item.specId, { assigneeId: to }, asAlice, [
      {
        type: "item.assigned",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: to,
          previousAssigneeId: null,
        },
      },
    ]);
  }

  it("does not raise a notice the recipient has switched off", async () => {
    await owner`insert into notification_preferences
      (workspace_id, user_id, event_type, channel, enabled)
      values (${ws}, ${user.bob}, 'item.assigned', 'in_app', false)`;

    await assign(user.bob);
    expect(await drain()).toEqual([]);
  });

  it("silences everyone the workspace default covers, and nobody else", async () => {
    await owner`insert into notification_defaults
      (workspace_id, event_type, channel, enabled)
      values (${ws}, 'item.assigned', 'in_app', false)`;
    // Carol has been here before and turned it back on. The default must not
    // reach her: that is the difference between a default and a policy.
    await owner`insert into notification_preferences
      (workspace_id, user_id, event_type, channel, enabled)
      values (${ws}, ${user.carol}, 'item.assigned', 'in_app', true)`;

    await assign(user.bob);
    expect(await drain()).toEqual([]);

    await owner`delete from notifications where workspace_id = ${ws}`;
    await assign(user.carol);
    const rows = await drain();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: user.carol,
      type: "item.assigned",
    });
  });

  it("still raises the in-app notice when only email is switched off", async () => {
    // Per channel, not per row. Muting mail must not take the inbox with it.
    await owner`insert into notification_preferences
      (workspace_id, user_id, event_type, channel, enabled)
      values (${ws}, ${user.bob}, 'item.assigned', 'email', false)`;

    await assign(user.bob);
    expect(await drain()).toHaveLength(1);
  });
});
