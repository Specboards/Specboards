import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What row-level security does, and does not, do for the paths that run on the
 * owner connection.
 *
 * The model-provider, usage, assistant and skills routes all resolve `getDb()`,
 * built from `DATABASE_URL`: the owner and DDL connection. Postgres exempts a
 * table's owner from RLS unless the table carries `FORCE ROW LEVEL SECURITY`,
 * and nothing in `infra/` sets it. So the policies those migrations reason about
 * at length do not apply on those paths, and the `workspaceId` predicate in the
 * service layer is the entire enforcement.
 *
 * This file exists because that is the kind of fact that gets quietly falsified.
 * It pins two things:
 *
 * 1. The premise. If FORCE ROW LEVEL SECURITY is ever added, or the app moves to
 *    a non-owner connection, the first case here fails and sends whoever did it
 *    to the comments that need updating with it.
 * 2. The trap in doing the move. `resolveConfig` reads a credential secret
 *    inside an ORDINARY MEMBER's assistant request, and the credential policy is
 *    org-admin only. On the RLS-enforced connection that read returns nothing,
 *    `apiKey` falls to null, and every non-admin's assistant call fails against
 *    a keyed endpoint with nothing in the response to explain it. Better to
 *    learn that from a red test than from a customer.
 *
 * Neither case asserts that the current arrangement is good. They assert that it
 * is what the comments say it is.
 *
 * ── The third thing the move needs, and why it is not tested here ───────────
 * The app role also needs the table grant, and on the live test and prod
 * clusters that is a real risk: they predate `infra/rls-role.sql`'s default
 * privileges and grant through a `writer` group role instead, which is why 0067,
 * 0068, 0070 and 0074 each carry a guarded GRANT block. A case for it was
 * written here and then removed, because it could not fail: `beforeAll` replays
 * `rls-role.sql`, whose `grant select ... on all tables` hands the role every
 * privilege the assertion then checks for. A local database cannot answer this
 * question; only the live clusters can, and `psql` against them is the way to
 * ask. Do not re-add it without changing the fixture first.
 *
 * Needs a migrated Postgres at DATABASE_URL and rights to create a role; skips
 * itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const member = randomUUID();
const admin = randomUUID();
const credential = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("row-level security on the owner connection", () => {
  let sql: postgres.Sql;

  /** Read as `specboards_app` would, acting as `userId`. */
  async function asAppRole<T>(
    userId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${userId}, true)`;
      await tx`set local role specboards_app`;
      return fn(tx);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    const file = join(process.cwd(), "..", "..", "infra", "rls-role.sql");
    await sql.unsafe(readFileSync(file, "utf8"));

    await sql`insert into workspaces (id, name, slug) values (${ws}, 'Owner conn', ${`own-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${member}, 'Member', ${`member-${suffix}@own.test`}),
      (${admin}, 'Admin', ${`admin-${suffix}@own.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${member}, 'member'),
      (${ws}, ${admin}, 'owner')`;
    await sql`insert into model_provider_credentials (id, workspace_id, secret, hint)
      values (${credential}, ${ws}, 'ENCRYPTED-SECRET', '...key')`;
  });

  afterAll(async () => {
    await sql`delete from model_provider_credentials where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([member, admin])}`;
    await sql.end({ timeout: 5 });
  });

  it("exempts the owner connection, because no table forces row-level security", async () => {
    // The premise, asserted the way it actually bites: the same SELECT that
    // returns nothing for a member on the app role returns the row here, on the
    // connection every model-provider and assistant route uses.
    const rows = await sql`select id from model_provider_credentials where id = ${credential}`;
    expect(rows).toHaveLength(1);

    const forced = await sql<{ table: string }[]>`
      select relname as table from pg_class
      where relrowsecurity and relforcerowsecurity and relnamespace = 'public'::regnamespace
      order by relname`;
    expect(forced).toEqual([]);
  });

  it("would hide a provider credential from an ordinary member on the app role", async () => {
    // The trap. `resolveConfig` runs this read on behalf of whoever asked the
    // assistant a question, which is usually not an admin. Moving that path onto
    // the app connection without a SECURITY DEFINER read turns every non-admin's
    // assistant call into a silent failure against a keyed endpoint.
    const asMember = await asAppRole(
      member,
      (tx) => tx`select id from model_provider_credentials where id = ${credential}`,
    );
    expect(asMember).toHaveLength(0);

    const asAdmin = await asAppRole(
      admin,
      (tx) => tx`select id from model_provider_credentials where id = ${credential}`,
    );
    expect(asAdmin).toHaveLength(1);
  });
});
