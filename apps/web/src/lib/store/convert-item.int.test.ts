import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Converting an item, against a migrated Postgres.
 *
 * The planner's rules are covered as pure functions in `convert-item.test.ts`.
 * What can only be checked here is that the write keeps everything the whole
 * feature exists to keep: the same row, the same id, the same comments and
 * history, with the level and the parent moving together in one transaction.
 * Recreating the card by hand is what this replaces, and a conversion that
 * quietly lost a comment would be the same loss with fewer steps.
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
const user = randomUUID();
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);
const scope = { userId: user, workspaceId: ws };

describe.skipIf(!OWNER_URL)("convertFeatureLevel", () => {
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
      (${ws}, 'Convert', ${"convert-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user}, 'Alice', ${`alice-${suffix}@convert.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user}, 'owner')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'initiative', 'Initiatives', 0, false),
             (${ws}, 'epic', 'Epics', 1, false),
             (${ws}, 'feature', 'Features', 2, false),
             (${ws}, 'work', 'Work Items', 3, true)`;
    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id = ${user}`;
    await owner.end({ timeout: 5 });
  });

  function newItem(level: string, over: Record<string, unknown> = {}) {
    return store.createFeature(
      { title: `A ${level}`, level, productId: product, ...over },
      scope,
    );
  }

  it("keeps the item's identity and everything hanging off it", async () => {
    const item = await newItem("feature", {
      details: "The body that would have had to be copied by hand.",
      tags: ["billing"],
      assigneeId: user,
    });
    await store.updateFeature(item.specId, { status: "defining" }, scope);
    const comment = await store.createComment(
      item.specId,
      { body: "Bigger than a feature." },
      scope,
    );

    await store.convertFeatureLevel(
      item.specId,
      { level: "epic", detachParent: false },
      scope,
    );

    const after = await store.getFeature(item.specId, scope);
    expect(after?.level).toBe("epic");
    // The same row, not a new one. This is the whole point: recreating the card
    // is what people did instead, and it cost them all of the below.
    expect(after?.specId).toBe(item.specId);
    expect(after?.title).toBe(item.title);
    expect(after?.status).toBe("defining");
    expect(after?.tags).toEqual(["billing"]);
    expect(after?.assigneeId).toBe(user);
    expect(after?.content).toContain("copied by hand");
    const comments = await store.listComments(item.specId, scope);
    expect(comments.map((c) => c.id)).toEqual([comment.id]);
  });

  it("records the change in the item's history, both ends of it", async () => {
    const item = await newItem("feature");
    await store.convertFeatureLevel(
      item.specId,
      { level: "epic", detachParent: false },
      scope,
    );

    const [event] = await store.listItemEvents(item.specId, scope);
    expect(event).toMatchObject({
      field: "level",
      before: "feature",
      after: "epic",
      actorId: user,
    });
  });

  it("drops the parent in the same write that changes the level", async () => {
    // Half of this would be worse than neither: an item detached from its
    // parent and still the old level has been damaged for no reason.
    const parent = await newItem("epic");
    const item = await newItem("feature", { parentSpecId: parent.specId });

    await store.convertFeatureLevel(
      item.specId,
      { level: "epic", detachParent: true },
      scope,
    );

    const after = await store.getFeature(item.specId, scope);
    expect(after?.level).toBe("epic");
    expect(after?.parentSpecId).toBeNull();
    // Both halves are in the ledger, so the history explains why the item left
    // its parent rather than showing it simply gone.
    const fields = (await store.listItemEvents(item.specId, scope)).map(
      (e) => e.field,
    );
    expect(fields).toContain("level");
    expect(fields).toContain("parentId");
  });

  it("leaves a parent alone when the conversion does not require dropping it", async () => {
    const parent = await newItem("initiative");
    const item = await newItem("epic", { parentSpecId: parent.specId });

    await store.convertFeatureLevel(
      item.specId,
      { level: "feature", detachParent: false },
      scope,
    );

    const after = await store.getFeature(item.specId, scope);
    expect(after?.parentSpecId).toBe(parent.specId);
  });

  it("records the conversion as an outbox event, so a mirror does not silently disagree", async () => {
    const item = await newItem("feature");
    await store.convertFeatureLevel(
      item.specId,
      { level: "epic", detachParent: false },
      scope,
      {
        type: "item.converted",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          from: "feature",
          to: "epic",
          detachedParent: false,
        },
      },
    );

    const [event] = await owner`select type, data from outbox_events
      where workspace_id = ${ws} and type = 'item.converted'
      order by created_at desc limit 1`;
    expect(event!.data).toMatchObject({
      specId: item.specId,
      from: "feature",
      to: "epic",
    });
  });

  it("refuses an item in a product the caller cannot write", async () => {
    const item = await newItem("feature");
    const stranger = { userId: randomUUID(), workspaceId: ws };
    await expect(
      store.convertFeatureLevel(
        item.specId,
        { level: "epic", detachParent: false },
        stranger,
      ),
    ).rejects.toThrow();
  });
});
