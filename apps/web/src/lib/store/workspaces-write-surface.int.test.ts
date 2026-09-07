import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What the tenant connection may do to the `workspaces` table.
 *
 * The answer is now "read, and nothing else". `setTransitionMode` was the only
 * tenant-path write, it writes `product_settings` instead since the setting
 * became per product, and migration 0001 dropped both the column it used to set
 * and the `workspaces_admin_update` policy that let an org admin set it.
 *
 * The sibling children of this epic each prove an RLS policy is *present*,
 * because their failure mode is the app layer saying yes while Postgres
 * silently writes nothing. This one is the mirror image: the risk is a write
 * privilege outliving the only feature that needed it, and quietly coming back
 * the next time someone reaches for `workspaces`. So it asserts the absence,
 * from the same non-owner role the app connects as, where RLS is actually live.
 *
 * Reading must still work, or every page that resolves a workspace breaks. That
 * is asserted here too, so "no writes" cannot be satisfied by locking the table
 * down altogether.
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
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!OWNER_URL)("workspaces write surface", () => {
  let owner: postgres.Sql;
  let app: postgres.Sql;

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
      (${ws}, 'Write surface', ${"wws-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${ownerId}, 'Owner', ${`owner-${suffix}@wws.test`})`;
    // An org owner: the most privileged tenant identity there is, and the one
    // the dropped policy used to admit.
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner')`;

    app = postgres(appUrlFrom(OWNER_URL!), { prepare: false, max: 2 });
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id = ${ownerId}`;
    await app.end({ timeout: 5 });
    await owner.end({ timeout: 5 });
  });

  /**
   * Run `fn` as the app role with the request scope the store sets: one
   * transaction-local `app.user_id`, which is what every RLS predicate here
   * reads (see `specboards_is_member` / `specboards_is_org_admin`).
   */
  async function asOwnerUser<T>(fn: (tx: postgres.TransactionSql) => Promise<T>) {
    return app.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${ownerId}, true)`;
      return fn(tx);
    });
  }

  it("still lets a member read their workspace", async () => {
    const rows = await asOwnerUser(
      (tx) => tx`select id, name from workspaces where id = ${ws}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Write surface");
  });

  it("leaves no write-capable policy that a tenant session could satisfy", async () => {
    // Not simply "no UPDATE policy": `workspaces_worker_all` survives and is
    // meant to. It is `for all to specboards_worker`, the separate role
    // webhook ingestion connects as (infra/worker-role.sql), and a tenant
    // connection is never that role. Filtering on `cmd = 'UPDATE'` alone would
    // also miss it, since an ALL policy covers UPDATE without saying so.
    //
    // What has to be gone is any policy a *tenant* session could satisfy, so
    // that is what this asks: every remaining write-capable policy must be
    // scoped to the worker role.
    const rows = await owner`
      select policyname, roles::text[] as roles from pg_policies
      where schemaname = 'public' and tablename = 'workspaces'
        and cmd in ('UPDATE', 'ALL')`;
    const tenantFacing = rows.filter((r) =>
      (r.roles as string[]).some((role) => role !== "specboards_worker"),
    );
    expect(tenantFacing.map((r) => r.policyname)).toEqual([]);
  });

  it("updates zero rows when an org owner tries to rename their workspace", async () => {
    // No UPDATE policy means RLS admits no row, so this is not an error: it is
    // a successful statement that changes nothing. That silence is exactly the
    // failure mode #256 was, which is why the assertion is on the row count and
    // not on a thrown error.
    const changed = await asOwnerUser(
      (tx) => tx`update workspaces set name = 'Renamed' where id = ${ws}`,
    );
    expect(changed.count).toBe(0);

    const [row] = await owner`select name from workspaces where id = ${ws}`;
    expect(row!.name).toBe("Write surface");
  });

  it("does not let the tenant connection insert or delete a workspace either", async () => {
    const inserted = await asOwnerUser(
      (tx) => tx`insert into workspaces (name, slug)
                 values ('Smuggled', ${"smuggled-" + suffix})
                 returning id`,
    ).catch(() => null);
    // Either refused outright or admitted no row; both mean nothing was made.
    expect(inserted === null || inserted.length === 0).toBe(true);
    const [total] = await owner`
      select count(*)::int as count from workspaces where slug = ${"smuggled-" + suffix}`;
    expect(total!.count).toBe(0);

    const deleted = await asOwnerUser(
      (tx) => tx`delete from workspaces where id = ${ws}`,
    );
    expect(deleted.count).toBe(0);
    const [still] = await owner`
      select count(*)::int as count from workspaces where id = ${ws}`;
    expect(still!.count).toBe(1);
  });

  it("no longer carries the transition_mode column the policy existed for", async () => {
    const rows = await owner`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'workspaces'
        and column_name = 'transition_mode'`;
    expect(rows).toHaveLength(0);
  });
});
