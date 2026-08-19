import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What a workspace member can read on a product they hold no grant on.
 *
 * `comments` and `assistant_messages` each paired a product-scoped `_read`
 * SELECT policy with a write policy declared `FOR ALL`. In Postgres a `FOR ALL`
 * policy's USING clause also governs SELECT, and permissive policies of the
 * same command combine with OR, so the narrow read policy could not restrict
 * anything: any member of the workspace satisfied the broader one. Both read
 * policies were inert from the day they were written, and 0075 rewrote one of
 * them without either working.
 *
 * The application layer held throughout (`listComments` and
 * `resolveAssistantItem` both check product access first), which is why this
 * was a failed backstop rather than a live leak. A backstop that has never once
 * applied is worth a test that would have noticed.
 *
 * Two kinds of assertion here, and the second is the one that matters longer:
 * the behaviour on these two tables, and the structural rule that no table may
 * pair a member-level `FOR ALL` with a SELECT policy it would defeat. The
 * second is what stops the next table repeating it.
 *
 * Needs a migrated Postgres at DATABASE_URL and rights to create a role; skips
 * itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const outsider = randomUUID();
const author = randomUUID();
const privateProduct = randomUUID();
const openProduct = randomUUID();
const privateItem = randomUUID();
const openItem = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("reading across a product boundary", () => {
  let sql: postgres.Sql;

  /**
   * Run as the RLS-constrained app role, as `outsider`.
   *
   * `set local role` inside a transaction, the same way the worker-role suite
   * does it: the owner connection bypasses RLS entirely, so a query that did
   * not switch role would pass no matter what the policies said.
   */
  async function asOutsider<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${outsider}, true)`;
      await tx`set local role specboards_app`;
      return fn(tx);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    // Applied exactly as an operator would, and idempotent, so running it here
    // also proves it still runs.
    const file = join(process.cwd(), "..", "..", "infra", "rls-role.sql");
    await sql.unsafe(readFileSync(file, "utf8"));

    await sql`insert into workspaces (id, name, slug) values (${ws}, 'Policies', ${`pol-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${outsider}, 'Outsider', ${`outsider-${suffix}@pol.test`}),
      (${author}, 'Author', ${`author-${suffix}@pol.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${outsider}, 'member'),
      (${ws}, ${author}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name, visibility) values
      (${privateProduct}, ${ws}, ${`secret-${suffix}`}, 'Secret', 'private'),
      (${openProduct}, ${ws}, ${`open-${suffix}`}, 'Open', 'org')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work', 0, true)`;
    await sql`insert into features (id, workspace_id, product_id, spec_id, title, level, status) values
      (${privateItem}, ${ws}, ${privateProduct}, ${randomUUID()}, 'CLASSIFIED', 'work', 'backlog'),
      (${openItem}, ${ws}, ${openProduct}, ${randomUUID()}, 'Open item', 'work', 'backlog')`;
    await sql`insert into comments (workspace_id, feature_id, author_id, body)
      values (${ws}, ${privateItem}, ${author}, 'CLASSIFIED-COMMENT')`;
    await sql`insert into assistant_messages (workspace_id, feature_id, author_id, role, content)
      values (${ws}, ${privateItem}, ${author}, 'assistant', 'CLASSIFIED-ANSWER')`;
  });

  afterAll(async () => {
    await sql`delete from assistant_messages where workspace_id = ${ws}`;
    await sql`delete from comments where workspace_id = ${ws}`;
    await sql`delete from features where workspace_id = ${ws}`;
    await sql`delete from workspace_levels where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([outsider, author])}`;
    await sql.end({ timeout: 5 });
  });

  it("hides an item on a product the member holds no grant on", async () => {
    // The control that always worked, here to prove the fixture is right: if
    // this ever fails, the two below prove nothing.
    const rows = await asOutsider((tx) => tx`select title from features where id = ${privateItem}`);
    expect(rows).toHaveLength(0);
  });

  it("hides that item's comments", async () => {
    const rows = await asOutsider((tx) => tx`select body from comments where feature_id = ${privateItem}`);
    expect(rows).toHaveLength(0);
  });

  it("hides that item's assistant thread", async () => {
    // 0068's own comment: reading the thread would otherwise be "a way to read
    // the item's content through the back door", which is exactly what an
    // assistant answer about an item contains.
    const rows = await asOutsider(
      (tx) => tx`select content from assistant_messages where feature_id = ${privateItem}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("still lets a member read and write on a product they can reach", async () => {
    // The other half: closing the read must not cost ordinary members the
    // writes the `FOR ALL` policy was there to allow.
    const id = randomUUID();
    await asOutsider(async (tx) => {
      await tx`insert into comments (id, workspace_id, feature_id, author_id, body)
        values (${id}, ${ws}, ${openItem}, ${outsider}, 'members can still write')`;
      await tx`update comments set body = 'and still edit' where id = ${id}`;
      const rows = await tx`select body from comments where id = ${id}`;
      expect(rows[0]!.body).toBe("and still edit");
      await tx`delete from comments where id = ${id}`;
      const gone = await tx`select 1 from comments where id = ${id}`;
      expect(gone).toHaveLength(0);
    });

    const asked = randomUUID();
    await asOutsider(async (tx) => {
      await tx`insert into assistant_messages (id, workspace_id, feature_id, author_id, role, content)
        values (${asked}, ${ws}, ${openItem}, ${outsider}, 'user', 'members can still ask')`;
      const rows = await tx`select content from assistant_messages where id = ${asked}`;
      expect(rows[0]!.content).toBe("members can still ask");
      await tx`delete from assistant_messages where id = ${asked}`;
    });
  });

  it("has no policy anywhere that defeats its own table's read policy", async () => {
    // The general form of the bug, so the next table cannot repeat it. A
    // permissive `FOR ALL` policy that applies to everyone and only asks for
    // membership makes any narrower SELECT policy on that table dead code.
    //
    // Role-targeted policies are excluded on purpose: the worker's `USING
    // (true)` policies are `TO specboards_worker`, which the app role is not,
    // so they never widen anything it can see.
    const defeated = await sql<{ table: string; policy: string }[]>`
      select a.tablename as table, a.policyname as policy
      from pg_policies a
      join pg_policies s
        on s.tablename = a.tablename
       and s.schemaname = a.schemaname
       and s.cmd = 'SELECT'
      where a.schemaname = 'public'
        and a.cmd = 'ALL'
        and a.permissive = 'PERMISSIVE'
        and a.roles::text = '{public}'
        and a.qual like '%is_member%'
      order by a.tablename`;
    expect(defeated).toEqual([]);
  });
});
