import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Transition mode round-trip: the workspace setting behind Settings > Cards >
 * Workflow > Transitions.
 *
 * Regression cover for a pair of silent failures that hid each other. The
 * setter returned its argument without checking that the UPDATE matched a row,
 * so a write against a workspace the query could not see still produced a 200
 * and a success toast; the getter read a missing row as "strict", so that
 * phantom save reported back as a deliberate setting. Between them, saving
 * Flexible looked like it had worked and the board stayed strict.
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
const userId = randomUUID();
const suffix = randomUUID().slice(0, 8);
const asOwner = { userId, workspaceId: ws };

describe.skipIf(!OWNER_URL)("transition mode (store)", () => {
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
      (${ws}, 'Transitions', ${"tm-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${userId}, 'Owner', ${`owner-${suffix}@tm.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${userId}, 'owner')`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id = ${userId}`;
    await owner.end({ timeout: 5 });
  });

  it("persists what was set, and reads it back", async () => {
    await store.setTransitionMode("strict", asOwner);
    expect(await store.getTransitionMode(asOwner)).toBe("strict");

    await store.setTransitionMode("flexible", asOwner);
    expect(await store.getTransitionMode(asOwner)).toBe("flexible");

    // The value is really in the row, not just echoed back by the setter.
    const [row] = await owner`
      select transition_mode from workspaces where id = ${ws}`;
    expect(row!.transition_mode).toBe("flexible");
  });

  it("refuses to report a save that matched no row", async () => {
    const missing = { userId, workspaceId: randomUUID() };
    await expect(store.setTransitionMode("flexible", missing)).rejects.toThrow(
      /not found/i,
    );
  });

  it("refuses to read a missing workspace as strict", async () => {
    const missing = { userId, workspaceId: randomUUID() };
    await expect(store.getTransitionMode(missing)).rejects.toThrow(/not found/i);
  });

  it("still falls back to strict for an unrecognized stored value", async () => {
    // The check constraint is what normally prevents this, so drop to raw SQL
    // with it disabled to simulate a hand-edited row.
    await owner`alter table workspaces drop constraint workspaces_transition_mode_check`;
    try {
      await owner`update workspaces set transition_mode = 'sideways' where id = ${ws}`;
      expect(await store.getTransitionMode(asOwner)).toBe("strict");
    } finally {
      await owner`update workspaces set transition_mode = 'flexible' where id = ${ws}`;
      await owner`alter table workspaces add constraint workspaces_transition_mode_check
        check (transition_mode in ('strict', 'flexible'))`;
    }
  });
});
