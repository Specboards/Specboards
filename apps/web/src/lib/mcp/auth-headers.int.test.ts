import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Which headers actually authenticate a call to `/api/mcp`.
 *
 * Written while documenting the endpoint for customers. The README offers
 * "an `x-api-key` for service accounts" while the endpoint's own 401 text and
 * its GET blurb ask for `Authorization: Bearer sb_…`, and nothing asserted
 * either. A guide cannot honestly tell an outside reader which header to send
 * when the two documents disagree and no test pins the answer down.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `hdr-${suffix}` };
const userId = randomUUID();

describe.skipIf(!DB_URL)("/api/mcp credential headers", () => {
  let sql: postgres.Sql;
  let key: string;
  let resolveMcpAuth: typeof import("./rpc").resolveMcpAuth;

  const req = (headers: Record<string, string>) =>
    new Request("https://app.example.test/api/mcp", { method: "POST", headers });

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    const db = createDb(DB_URL!);
    ({ resolveMcpAuth } = await import("./rpc"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Headers', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Header Owner', ${`hdr-${suffix}@mcp.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;

    const { createApiKey } = await import("@/lib/api-keys");
    key = (await createApiKey(db, userId, "header test", null, ["features:read"]))
      .key;
  });

  afterAll(async () => {
    await sql`delete from api_keys where user_id = ${userId}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("accepts Authorization: Bearer sb_…", async () => {
    const auth = await resolveMcpAuth(
      req({ authorization: `Bearer ${key}`, "x-org-slug": workspace.slug }),
    );
    expect(auth.ok).toBe(true);
  });

  it("accepts x-api-key too, exactly as the README says", async () => {
    // The claim under test. `extractApiKey` reads `x-api-key` before the
    // Authorization header, so both work on this endpoint and the README is
    // not, as was assumed, sending outside readers into a wall.
    const auth = await resolveMcpAuth(
      req({ "x-api-key": key, "x-org-slug": workspace.slug }),
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx.scopes).toEqual(["features:read"]);
  });

  it("treats an unknown key as no credential at all", async () => {
    const auth = await resolveMcpAuth(req({ "x-api-key": "sb_nonsense" }));
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    // Unauthenticated rather than forbidden, so the route answers with the 401
    // + WWW-Authenticate challenge that starts an OAuth client's sign-in.
    expect(auth.unauthenticated).toBe(true);
  });

  it("ignores a bearer token that is not one of ours", async () => {
    const auth = await resolveMcpAuth(req({ authorization: "Bearer not-an-sb-key" }));
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.unauthenticated).toBe(true);
  });
});
