import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A real API key must not authenticate a browser-session route.
 *
 * `getSessionUser()` checked `x-api-key` / `Authorization: Bearer sb_…` before
 * the session cookie, so ten interactive routes accepted keys. None of them run
 * the authorize helpers, so no scope or quota check ran either: a key scoped
 * `features:read` could disconnect its owner's GitHub credential or repoint
 * their MCP workspace binding.
 *
 * `route-auth.test.ts` holds the shape of the fix (which helper each route
 * calls). This asserts the behaviour with a key that really verifies, because
 * "the helper is named correctly" and "the key is refused" are different claims.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const workspace = { id: randomUUID(), slug: `bsauth-${randomUUID().slice(0, 8)}` };
const userId = randomUUID();

describe.skipIf(!DB_URL)("browser-session routes reject API keys", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let scopedKey: string;
  let legacyKey: string;
  let getBrowserSessionUser: typeof import("./auth-session").getBrowserSessionUser;
  let resolveReadAccess: typeof import("./auth-session").resolveReadAccess;

  function keyed(url: string, key: string, method = "GET"): Request {
    return new Request(url, {
      method,
      headers: { authorization: `Bearer ${key}`, "x-org-slug": workspace.slug },
    });
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ getBrowserSessionUser, resolveReadAccess } = await import("./auth-session"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Browser Session Auth', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Key Owner', ${`owner-${workspace.slug}@bsauth.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;

    const { createApiKey } = await import("./api-keys");
    scopedKey = (await createApiKey(db, userId, "scoped", null, ["features:read"])).key;
    // Empty scopes: a legacy full-access key, the most privileged thing a key
    // can be. Even this must not stand in for a browser session.
    legacyKey = (await createApiKey(db, userId, "legacy", null, [])).key;
  });

  afterAll(async () => {
    await sql`delete from api_keys where user_id = ${userId}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("resolves nobody from a scoped key", async () => {
    const req = keyed("https://app.example.test/api/v1/github/user/connect", scopedKey);
    expect(await getBrowserSessionUser(req)).toBeNull();
  });

  it("resolves nobody from a legacy full-access key either", async () => {
    const req = keyed("https://app.example.test/api/mcp/workspace-binding", legacyKey, "POST");
    expect(await getBrowserSessionUser(req)).toBeNull();
  });

  it("still resolves that same key through the REST authorize path", async () => {
    // The keys are valid: the point is that the browser helper ignores them,
    // not that they stopped working. Without this, the tests above would pass
    // just as well against a typo'd key.
    const access = await resolveReadAccess(
      keyed("https://app.example.test/api/v1/features", scopedKey),
    );
    expect(access.ok).toBe(true);
    if (!access.ok) return;
    expect(access.access?.userId).toBe(userId);
    expect(access.access?.workspaceId).toBe(workspace.id);
  });

  /**
   * The model connection is declared never delegable: `SCOPE_RESOURCES` leaves
   * `model-provider` out on purpose, because it decides where the workspace's
   * prompts are sent. That stopped a new key naming the resource; it never
   * stopped an existing broad key from arriving, because `authorizeOrgAdmin`
   * resolves a key before the session cookie. Both keys below belong to the
   * workspace owner, so before the guard they reached all five routes.
   */
  it("refuses every model connection route with a key", async () => {
    const routes = await Promise.all([
      import("@/app/api/v1/model-provider/route"),
      import("@/app/api/v1/model-provider/test/route"),
      import("@/app/api/v1/model-provider/limits/route"),
      import("@/app/api/v1/model-provider/usage/route"),
      import("@/app/api/v1/model-provider/models/route"),
    ]);
    const [root, test, limits, usage, models] = routes;

    const handlers: [string, (req: Request) => Promise<Response>][] = [
      ["GET /model-provider", root!.GET],
      ["PUT /model-provider", root!.PUT],
      ["DELETE /model-provider", root!.DELETE],
      ["POST /model-provider/test", test!.POST],
      ["GET /model-provider/limits", limits!.GET],
      ["PUT /model-provider/limits", limits!.PUT],
      ["GET /model-provider/usage", usage!.GET],
      ["POST /model-provider/models", models!.POST],
    ];

    const url = "https://app.example.test/api/v1/model-provider";
    for (const [label, handler] of handlers) {
      for (const key of [scopedKey, legacyKey]) {
        const res = await handler(keyed(url, key, "POST"));
        expect(res.status, label).toBe(403);
        const body = (await res.json()) as { error?: string };
        expect(body.error, label).toMatch(/browser session/);
      }
    }
  });

  it("refuses to disconnect a GitHub credential with a key", async () => {
    // End to end through the real handler: this is the route where the review
    // found the sharpest consequence, so assert the response, not just the
    // helper it calls.
    const { DELETE } = await import(
      "@/app/api/v1/github/user/connection/route"
    );
    const url = `https://app.example.test/api/v1/github/user/connection?org=${workspace.slug}`;
    for (const key of [scopedKey, legacyKey]) {
      const res: Response = await DELETE(keyed(url, key, "DELETE"));
      expect(res.status).toBe(401);
    }
  });
});
