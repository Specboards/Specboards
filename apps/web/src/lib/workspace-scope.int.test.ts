import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveApiMembership } from "./workspace";

/**
 * Multi-org API scoping (docs/security-review-2026-07.md, P1 "make the active
 * organization explicit for all API requests"). A user who owns org A and is
 * only a read-only member of org B must never have a request silently resolve
 * to the wrong org: naming an org pins to THAT org, naming none is rejected as
 * ambiguous, and naming an org they don't belong to is refused.
 *
 * Runs against DATABASE_URL in multi-tenant mode (SPECBOARDS_MULTI_TENANT=true,
 * set in beforeAll). Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const orgA = { id: randomUUID(), slug: `scope-a-${randomUUID().slice(0, 8)}` };
const orgB = { id: randomUUID(), slug: `scope-b-${randomUUID().slice(0, 8)}` };
const orgC = { id: randomUUID(), slug: `scope-c-${randomUUID().slice(0, 8)}` };
const user = randomUUID();
const loner = randomUUID();

describe.skipIf(!DB_URL)("resolveApiMembership (multi-org)", () => {
  let sql: postgres.Sql;
  let savedMultiTenant: string | undefined;
  let db: import("@specboards/db").Database;

  beforeAll(async () => {
    savedMultiTenant = process.env.SPECBOARDS_MULTI_TENANT;
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug) values
      (${orgA.id}, 'Org A', ${orgA.slug}),
      (${orgB.id}, 'Org B', ${orgB.slug}),
      (${orgC.id}, 'Org C', ${orgC.slug})`;
    await sql`insert into users (id, name, email) values
      (${user}, 'Multi', ${`multi-${orgA.slug}@scope.test`}),
      (${loner}, 'Loner', ${`loner-${orgA.slug}@scope.test`})`;
    // `user`: owner of A, read-only (member) of B, not in C.
    await sql`insert into members (workspace_id, user_id, role) values
      (${orgA.id}, ${user}, 'owner'),
      (${orgB.id}, ${user}, 'member'),
      (${orgC.id}, ${loner}, 'owner')`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id in (${orgA.id}, ${orgB.id}, ${orgC.id})`;
    await sql`delete from users where id in (${user}, ${loner})`;
    await sql.end({ timeout: 5 });
    if (savedMultiTenant === undefined) delete process.env.SPECBOARDS_MULTI_TENANT;
    else process.env.SPECBOARDS_MULTI_TENANT = savedMultiTenant;
  });

  it("pins to org A when the caller names A (owner role preserved)", async () => {
    const r = await resolveApiMembership(db, user, orgA.slug);
    expect(r.ok).toBe(true);
    expect(r.ok && r.membership.workspaceId).toBe(orgA.id);
    expect(r.ok && r.membership.role).toBe("owner");
  });

  it("pins to org B when the caller names B (read-only role preserved)", async () => {
    const r = await resolveApiMembership(db, user, orgB.slug);
    expect(r.ok).toBe(true);
    expect(r.ok && r.membership.workspaceId).toBe(orgB.id);
    expect(r.ok && r.membership.role).toBe("member");
  });

  it("rejects a request for org C, where the caller has no membership", async () => {
    const r = await resolveApiMembership(db, user, orgC.slug);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("not_a_member");
  });

  it("rejects an unknown org slug the same way as a non-membership", async () => {
    const r = await resolveApiMembership(db, user, "no-such-org-xyz");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("not_a_member");
  });

  it("refuses to guess when a multi-org caller names none", async () => {
    const r = await resolveApiMembership(db, user, null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("org_ambiguous");
  });

  it("resolves the sole membership for a single-org caller with no slug", async () => {
    const r = await resolveApiMembership(db, loner, null);
    expect(r.ok).toBe(true);
    expect(r.ok && r.membership.workspaceId).toBe(orgC.id);
  });
});
