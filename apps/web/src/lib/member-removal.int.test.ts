import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * What "Remove" actually does, on each tenancy mode.
 *
 * The defect (F28): on a single-tenant deployment `removeMember` deleted the
 * membership rows and nothing else, while `ensureMembership` auto-joins any
 * authenticated user to the one workspace. `resolveActiveWorkspace` calls that
 * BEFORE it compares the URL slug, so a removed person was re-joined as a
 * `member` on their next page load, or on any API call that omits an org slug,
 * which the CLI and MCP callers routinely do. "Remove" quietly meant "demote to
 * member", and their API keys were never revoked either.
 *
 * Not live for us: `SPECBOARDS_MULTI_TENANT` is set on both hosted apps, and
 * multi-tenant never auto-joins. It is a real defect for every self-host, where
 * single-tenant is the documented default, and where today only "Deactivate"
 * revoked anything.
 *
 * So the cases below drive the real `ensureMembership`, once per mode, because
 * asserting on the rows alone would miss the auto-join entirely: that is the
 * step that undid the removal.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const suffix = randomUUID().slice(0, 8);
const ws = randomUUID();
const ownerId = randomUUID();
const leaverId = randomUUID();

describe.skipIf(!DB_URL)("removing a member", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./org-members-service");
  let workspace: typeof import("./workspace");

  const wasMultiTenant = process.env.SPECBOARDS_MULTI_TENANT;

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./org-members-service");
    workspace = await import("./workspace");

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Removal', ${`rm-${suffix}`})`;
    await sql`insert into users (id, name, email) values
      (${ownerId}, 'Ada', ${`ada-${suffix}@rm.test`}),
      (${leaverId}, 'Lee', ${`lee-${suffix}@rm.test`})`;
  });

  /** Put the pair back, so each case starts from "both are members". */
  afterEach(async () => {
    await sql`delete from api_keys where user_id = ${leaverId}`;
    await sql`delete from members where workspace_id = ${ws}`;
    if (wasMultiTenant === undefined) delete process.env.SPECBOARDS_MULTI_TENANT;
    else process.env.SPECBOARDS_MULTI_TENANT = wasMultiTenant;
  });

  afterAll(async () => {
    await sql`delete from api_keys where user_id = ${leaverId}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([ownerId, leaverId])}`;
    await sql.end({ timeout: 5 });
  });

  async function seedMembers(): Promise<void> {
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner'),
      (${ws}, ${leaverId}, 'member')`;
  }

  async function seedKey(): Promise<string> {
    const id = randomUUID();
    await sql`insert into api_keys (id, user_id, name, prefix, key_hash, scopes)
      values (${id}, ${leaverId}, 'CLI', ${`sb_${suffix}`}, ${`hash-${id}`}, '{}')`;
    return id;
  }

  async function keyRevoked(id: string): Promise<boolean> {
    const [row] = await sql<{ revoked: Date | null }[]>`
      select revoked_at as revoked from api_keys where id = ${id}`;
    return row?.revoked != null;
  }

  describe("on a single-tenant deployment", () => {
    it("keeps the removed member out on their next request", async () => {
      delete process.env.SPECBOARDS_MULTI_TENANT;
      await seedMembers();

      await svc.removeMember(db, ws, leaverId);

      // The assertion that matters, and the one row-counting would miss:
      // `ensureMembership` is what the next page load calls, and it used to
      // hand the removed person a fresh `member` row.
      const rejoined = await workspace.ensureMembership(db, leaverId);
      expect(rejoined).toBeNull();

      // The row is still there, deactivated, which is what makes the auto-join
      // insert a no-op rather than a resurrection.
      const [row] = await sql<{ deactivated: Date | null }[]>`
        select deactivated_at as deactivated from members
        where workspace_id = ${ws} and user_id = ${leaverId}`;
      expect(row).toBeDefined();
      expect(row!.deactivated).not.toBeNull();
    });

    it("revokes the API keys that would have outlived the membership", async () => {
      delete process.env.SPECBOARDS_MULTI_TENANT;
      await seedMembers();
      const keyId = await seedKey();

      await svc.removeMember(db, ws, leaverId);

      expect(await keyRevoked(keyId)).toBe(true);
    });

    it("revokes keys on deactivate as well, and does not restore them", async () => {
      delete process.env.SPECBOARDS_MULTI_TENANT;
      await seedMembers();
      const keyId = await seedKey();

      await svc.setMemberActive(db, ws, leaverId, false);
      expect(await keyRevoked(keyId)).toBe(true);

      // Reactivating restores the membership and deliberately NOT the
      // credentials: a key that was live during a suspension is never live
      // again afterwards.
      await svc.setMemberActive(db, ws, leaverId, true);
      expect(await keyRevoked(keyId)).toBe(true);
      expect(await workspace.ensureMembership(db, leaverId)).not.toBeNull();
    });
  });

  describe("on a multi-tenant deployment", () => {
    it("still deletes the row, because nothing auto-joins there", async () => {
      process.env.SPECBOARDS_MULTI_TENANT = "true";
      await seedMembers();

      await svc.removeMember(db, ws, leaverId);

      // Deleted, not deactivated: leaving a tombstone would keep the person
      // listed in an org they are no longer in, and there is no auto-join to
      // defend against.
      const rows = await sql`select 1 from members
        where workspace_id = ${ws} and user_id = ${leaverId}`;
      expect(rows).toHaveLength(0);
      expect(await workspace.ensureMembership(db, leaverId)).toBeNull();
    });

    it("leaves their keys alone, because a key may serve another org", async () => {
      process.env.SPECBOARDS_MULTI_TENANT = "true";
      await seedMembers();
      const keyId = await seedKey();

      await svc.removeMember(db, ws, leaverId);

      // `api_keys` is keyed on the user, not a workspace, and resolves its org
      // through membership at request time. Removing them from this org already
      // ends the key's access here; revoking it outright would also cut off an
      // org where they are still a member.
      expect(await keyRevoked(keyId)).toBe(false);
    });
  });
});
