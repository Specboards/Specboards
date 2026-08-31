import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Progress roll-up on a workspace that renamed its workflow.
 *
 * "Finished" used to be the literal status key `done`, which is only this
 * product's terminal stage by default. A team whose stages end in `shipped`
 * therefore saw every derived figure sit at zero: hierarchy roll-up, cycle
 * totals, goal delivery, release progress, and the roadmap bars that are drawn
 * from the roll-up. Nothing errored, so the board simply looked stalled.
 *
 * Exercised against a migrated Postgres with RLS active, through the same
 * non-owner app role as the other store suites, because the resolution reads
 * `workspace_statuses` inside the scoped transaction and has to be visible
 * under RLS to work at all.
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
const ownerId = randomUUID();
const defaultProduct = randomUUID();
const ownStagesProduct = randomUUID();
const suffix = randomUUID().slice(0, 8);
const asOwner = { userId: ownerId, workspaceId: ws };

describe.skipIf(!OWNER_URL)("roll-up on a renamed workflow", () => {
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
      (${ws}, 'Renamed', ${"done-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${ownerId}, 'Owner', ${`owner-${suffix}@done.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${defaultProduct}, ${ws}, 'alpha', 'Alpha'),
      (${ownStagesProduct}, ${ws}, 'beta', 'Beta')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'feature', 'Features', 0, false),
      (${ws}, 'work', 'Work Items', 1, true)`;
    // The workspace default: nothing called "done" anywhere in it.
    await owner`insert into workspace_statuses (workspace_id, product_id, key, label, position) values
      (${ws}, null, 'todo', 'To do', 0),
      (${ws}, null, 'doing', 'Doing', 1),
      (${ws}, null, 'shipped', 'Shipped', 2)`;
    // Beta overrides the set, and ends somewhere else again.
    await owner`insert into workspace_statuses (workspace_id, product_id, key, label, position) values
      (${ws}, ${ownStagesProduct}, 'queued', 'Queued', 0),
      (${ws}, ${ownStagesProduct}, 'live', 'Live', 1)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id = ${ownerId}`;
    await owner.end({ timeout: 5 });
  });

  it("counts the workflow's own terminal stage as done", async () => {
    const parent = await store.createFeature(
      { title: "Renamed parent", level: "feature", productId: defaultProduct },
      asOwner,
    );
    const child = await store.createFeature(
      {
        title: "Renamed child",
        level: "work",
        productId: defaultProduct,
        parentSpecId: parent.specId,
      },
      asOwner,
    );
    await store.createFeature(
      {
        title: "Still going",
        level: "work",
        productId: defaultProduct,
        parentSpecId: parent.specId,
      },
      asOwner,
    );

    const before = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === parent.specId,
    );
    expect(before!.childCount).toBe(2);
    expect(before!.childDoneCount).toBe(0);

    await store.updateFeature(child.specId, { status: "shipped" }, asOwner);

    const after = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === parent.specId,
    );
    // The regression this suite exists for: before, "shipped" was not "done",
    // so this stayed at 0 no matter how much work the team finished.
    expect(after!.childDoneCount).toBe(1);

    // The detail read derives the same figure by a different query, so the card
    // and the drawer must not disagree about it.
    const detail = await store.getFeature(parent.specId, asOwner);
    expect(detail!.childDoneCount).toBe(1);
  });

  it("judges each product by its own terminal stage", async () => {
    const parent = await store.createFeature(
      { title: "Beta parent", level: "feature", productId: ownStagesProduct },
      asOwner,
    );
    const child = await store.createFeature(
      {
        title: "Beta child",
        level: "work",
        productId: ownStagesProduct,
        parentSpecId: parent.specId,
      },
      asOwner,
    );

    // "shipped" is the *workspace* terminal stage but a stranger to Beta, so it
    // must not count here. Written straight to the column: the workflow would
    // rightly refuse the move, and the point is that the roll-up does not lean
    // on that refusal to stay correct.
    await owner`update features set status = 'shipped' where spec_id = ${child.specId}`;
    let after = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === parent.specId,
    );
    expect(after!.childDoneCount).toBe(0);

    await store.updateFeature(child.specId, { status: "live" }, asOwner);
    after = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === parent.specId,
    );
    expect(after!.childDoneCount).toBe(1);
  });
});
