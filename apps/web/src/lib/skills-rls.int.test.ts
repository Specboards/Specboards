import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The skills service against the connection whose policies are real.
 *
 * `workspace_assistant_skills` (0070) is member-read and org-admin-write, and
 * until this change nothing evaluated either rule: the routes ran on the owner
 * connection, where a table's owner is exempt from row-level security. The
 * admin check lived only in the route.
 *
 * These cases drive the service over a connection that connects as
 * `specboards_app`, so what is being asserted is the database's answer and not
 * the route's. The interesting one is the last: an ordinary member's write is
 * refused by the policy even though nothing in the service or the route is
 * asked, which is the property the whole move exists to buy.
 *
 * Runs against DATABASE_URL, provisioning its own non-owner login rather than
 * asking for one, so it cannot quietly skip. The first case asserts the
 * connection really is non-owner: on the owner connection every case below
 * passes without a policy being consulted, which would report the backstop as
 * working when it is absent.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const owner = randomUUID();
const member = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: owner, workspaceId: ws };
const asMember = { userId: member, workspaceId: ws };

const ROWS = [
  {
    key: "grill",
    name: "Grill me",
    description: "Ask hard questions.",
    instructions: "Interrogate the spec.",
    surface: "item" as const,
    enabled: true,
    position: 0,
  },
];

/**
 * A non-owner login derived from the owner URL, provisioned the way
 * `infra/rls-role.sql` does.
 *
 * Deliberately NOT read from `DATABASE_URL_APP`: CI does not set it, so a suite
 * that required it would skip there and this guard would never actually run.
 * Same approach, and the same role, as `store/rls-isolation.int.test.ts`.
 */
const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

async function provisionAppRole(owner: postgres.Sql): Promise<void> {
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
}

describe.skipIf(!DB_URL)("assistant skills over the app role", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./skills-service");

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    svc = await import("./skills-service");

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await provisionAppRole(sql);
    // The scoped connection, which is the whole point: `getAppDb()` resolves
    // an equivalent string in production.
    db = createDb(appUrlFrom(DB_URL!));

    await sql`insert into workspaces (id, name, slug) values (${ws}, 'Skills', ${`skl-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Ada', ${`ada-${suffix}@skl.test`}),
      (${member}, 'Mo', ${`mo-${suffix}@skl.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'),
      (${ws}, ${member}, 'member')`;
  });

  afterAll(async () => {
    await sql`delete from workspace_assistant_skills where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([owner, member])}`;
    await sql.end({ timeout: 5 });
  });

  it("connects as the non-owner role, so the policies are not bypassed", async () => {
    // If this fails, every other case here is meaningless: an owner connection
    // satisfies them all without a policy ever being consulted.
    const { sql: raw } = await import("@specboards/db");
    const rows = await db.execute(raw`select current_user as who`);
    const who = (rows as unknown as { who: string }[])[0]?.who;
    expect(who).toBe(APP_ROLE);
  });

  it("lets an admin write the set and a member read it back", async () => {
    const saved = await svc.replaceSkills(db, asOwner, ROWS);
    expect(saved.find((s) => s.key === "grill")?.name).toBe("Grill me");

    // A different person, in the same workspace, over the same policies.
    const seen = await svc.listSkills(db, asMember);
    expect(seen.find((s) => s.key === "grill")?.name).toBe("Grill me");
  });

  it("refuses an ordinary member's write in the database, not in the route", async () => {
    // The property the move buys. Nothing in `replaceSkills` checks a role, and
    // this call never reaches the route's `authorizeOrgAdmin`. The refusal is
    // `workspace_assistant_skills_write` doing its job.
    //
    // It surfaces as the delete matching no rows and the insert failing its
    // WITH CHECK, so the assertion is on the outcome rather than on a message:
    // either it throws, or the workspace's stored set is unchanged. Both are
    // "the member did not get their way"; neither is "the member rewrote it".
    let threw = false;
    try {
      await svc.replaceSkills(db, asMember, [
        { ...ROWS[0]!, key: "sneaky", name: "Written by a member" },
      ]);
    } catch {
      threw = true;
    }

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_assistant_skills
      where workspace_id = ${ws} and key = 'sneaky'`;
    expect(row!.n).toBe(0);

    // And the admin's set survived, so the delete half did not land either.
    const [kept] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_assistant_skills
      where workspace_id = ${ws} and key = 'grill'`;
    expect(kept!.n).toBe(1);
    expect(threw).toBe(true);
  });
});
