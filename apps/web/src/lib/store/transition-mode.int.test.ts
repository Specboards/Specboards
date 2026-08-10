import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Transition mode round-trip: the setting behind Settings > Cards > Workflow >
 * Transitions, now configured per product with a workspace-wide default.
 *
 * Two things are under test, and the second is why this file cannot be a unit
 * test.
 *
 * 1. Resolution. A product inherits the workspace default until it overrides
 *    it, and reverting to inherited follows the default again afterwards.
 *
 * 2. That the database, not the route, is what actually stops the wrong person
 *    writing. This is regression cover for #256, where the app layer said yes
 *    and Postgres silently updated zero rows: the store connects as a non-owner
 *    role, so RLS is live, and the write tests below FAIL if the
 *    `product_settings_write` policy from migration 0064 is missing or keyed to
 *    the wrong predicate. An app-layer test cannot see that failure, because in
 *    an app-layer test the app layer is the only thing checking.
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
const alphaAdminId = randomUUID();
const plainMemberId = randomUUID();
const alpha = randomUUID();
const beta = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: ownerId, workspaceId: ws };
/** Product admin of Alpha only, and an ordinary workspace member otherwise. */
const asAlphaAdmin = { userId: alphaAdminId, workspaceId: ws };
/** Member with no product grant anywhere. */
const asMember = { userId: plainMemberId, workspaceId: ws };

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
      (${ownerId}, 'Owner', ${`owner-${suffix}@tm.test`}),
      (${alphaAdminId}, 'Alpha admin', ${`alpha-${suffix}@tm.test`}),
      (${plainMemberId}, 'Member', ${`member-${suffix}@tm.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner'),
      (${ws}, ${alphaAdminId}, 'member'),
      (${ws}, ${plainMemberId}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${alpha}, ${ws}, 'alpha', 'Alpha'),
      (${beta}, ${ws}, 'beta', 'Beta')`;
    await owner`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${alpha}, ${alphaAdminId}, 'admin')`;

    // A workspace created by hand has no default row; the store seeds it on the
    // first write, so give it the same starting point migration 0064 gives a
    // real workspace.
    await owner`insert into product_settings (workspace_id, product_id, transition_mode)
      values (${ws}, null, 'flexible')`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${ownerId}, ${alphaAdminId}, ${plainMemberId})`;
    await owner.end({ timeout: 5 });
  });

  it("persists the workspace default, and reads it back", async () => {
    await store.setTransitionMode("strict", asOwner);
    expect(await store.getTransitionMode(asOwner)).toBe("strict");

    await store.setTransitionMode("flexible", asOwner);
    expect(await store.getTransitionMode(asOwner)).toBe("flexible");

    // The value is really in the row, not just echoed back by the setter.
    const [row] = await owner`
      select transition_mode from product_settings
      where workspace_id = ${ws} and product_id is null`;
    expect(row!.transition_mode).toBe("flexible");
  });

  it("lets two products in one workspace disagree", async () => {
    await store.setTransitionMode("flexible", asOwner);
    await store.setTransitionMode("strict", asOwner, alpha);

    expect(await store.getTransitionMode(asOwner, alpha)).toBe("strict");
    // Beta never opted out, so it still follows the workspace.
    expect(await store.getTransitionMode(asOwner, beta)).toBe("flexible");
    expect(await store.getTransitionMode(asOwner)).toBe("flexible");
  });

  it("keeps an unconfigured product following the default as it changes", async () => {
    await store.setTransitionMode(null, asOwner, beta);
    await store.setTransitionMode("strict", asOwner);
    expect(await store.getTransitionMode(asOwner, beta)).toBe("strict");

    await store.setTransitionMode("flexible", asOwner);
    expect(await store.getTransitionMode(asOwner, beta)).toBe("flexible");
  });

  it("reverts an overridden product to inheriting", async () => {
    await store.setTransitionMode("flexible", asOwner);
    await store.setTransitionMode("strict", asOwner, alpha);
    expect(await store.getTransitionMode(asOwner, alpha)).toBe("strict");

    // The revert reports what it now inherits, not the null it was given.
    expect(await store.setTransitionMode(null, asOwner, alpha)).toBe("flexible");
    expect(await store.getTransitionMode(asOwner, alpha)).toBe("flexible");

    // The row survives the revert, holding an explicit "no opinion", so the
    // other settings that will live on it are not collateral damage.
    const [row] = await owner`
      select transition_mode from product_settings
      where workspace_id = ${ws} and product_id = ${alpha}`;
    expect(row!.transition_mode).toBeNull();
  });

  it("lists the default and every override in one read", async () => {
    await store.setTransitionMode("flexible", asOwner);
    await store.setTransitionMode("strict", asOwner, alpha);
    await store.setTransitionMode(null, asOwner, beta);

    expect(await store.listTransitionModes(asOwner)).toEqual({
      workspaceDefault: "flexible",
      // Beta is absent rather than present-and-null: inheriting is inheriting,
      // whether or not a row exists to say so.
      overrides: { [alpha]: "strict" },
    });
  });

  it("refuses to make the workspace default inherit from nothing", async () => {
    await expect(store.setTransitionMode(null, asOwner)).rejects.toThrow(
      /cannot be set to inherited/i,
    );
  });

  // ── The RLS half. Each of these fails without migration 0064's write policy.
  // ───────────────────────────────────────────────────────────────────────

  it("lets a product admin configure their own product", async () => {
    expect(await store.setTransitionMode("strict", asAlphaAdmin, alpha)).toBe(
      "strict",
    );
    const [row] = await owner`
      select transition_mode from product_settings
      where workspace_id = ${ws} and product_id = ${alpha}`;
    expect(row!.transition_mode).toBe("strict");
  });

  it("refuses a product admin on someone else's product", async () => {
    await expect(
      store.setTransitionMode("strict", asAlphaAdmin, beta),
    ).rejects.toThrow();

    // And nothing was written: the point is that the refusal is real, not that
    // an error was raised somewhere on the way.
    const [row] = await owner`
      select transition_mode from product_settings
      where workspace_id = ${ws} and product_id = ${beta}`;
    expect(row?.transition_mode ?? null).toBeNull();
  });

  it("refuses a product admin on the workspace default", async () => {
    await store.setTransitionMode("flexible", asOwner);
    await expect(
      store.setTransitionMode("strict", asAlphaAdmin),
    ).rejects.toThrow();
    expect(await store.getTransitionMode(asOwner)).toBe("flexible");
  });

  it("refuses a plain member everywhere", async () => {
    await expect(
      store.setTransitionMode("strict", asMember, alpha),
    ).rejects.toThrow();
    await expect(store.setTransitionMode("strict", asMember)).rejects.toThrow();
  });

  it("lets the workspace owner configure any product", async () => {
    expect(await store.setTransitionMode("strict", asOwner, beta)).toBe(
      "strict",
    );
    await store.setTransitionMode(null, asOwner, beta);
  });

  it("refuses to report a save that matched no row", async () => {
    const missing = { userId: ownerId, workspaceId: randomUUID() };
    await expect(store.setTransitionMode("flexible", missing)).rejects.toThrow();
  });

  it("refuses to read a missing workspace as strict", async () => {
    const missing = { userId: ownerId, workspaceId: randomUUID() };
    await expect(store.getTransitionMode(missing)).rejects.toThrow(/not found/i);
  });

  it("still falls back to strict for an unrecognized stored value", async () => {
    // The check constraint is what normally prevents this, so drop to raw SQL
    // with it disabled to simulate a hand-edited row.
    await owner`alter table product_settings
      drop constraint product_settings_transition_mode_check`;
    try {
      await owner`update product_settings set transition_mode = 'sideways'
        where workspace_id = ${ws} and product_id is null`;
      expect(await store.getTransitionMode(asOwner)).toBe("strict");
    } finally {
      await owner`update product_settings set transition_mode = 'flexible'
        where workspace_id = ${ws} and product_id is null`;
      await owner`alter table product_settings
        add constraint product_settings_transition_mode_check
        check (transition_mode is null or transition_mode in ('strict', 'flexible'))`;
    }
  });
});
