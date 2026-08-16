import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Rate limiting on `/api/mcp`, driven through the real credential resolver.
 *
 * The gap this covers: `/api/mcp` had no quota of its own. The `sb_` key path
 * was throttled only incidentally, because it shares `enforceKeyPolicies` with
 * the REST helper, and the OAuth path never reached that code at all - so the
 * connection an external customer's agent actually uses was unthrottled. The
 * per-request unit was wrong too: one JSON-RPC request carries up to 50 calls,
 * any of which can be a git commit.
 *
 * So the OAuth path is the one asserted here end to end. It mints a real
 * `oauth_applications` + `oauth_access_tokens` pair, puts the token on a real
 * Request, and drives `resolveMcpAuth`, which is the only way to prove the
 * credential key is shaped per connection rather than per user.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Better Auth refuses to start without one; the value is irrelevant here.
process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `mcprate-${suffix}` };
const userId = randomUUID();
/** Two clients, one user: the case that proves budgets are per connection. */
const clientA = `mcprate-a-${suffix}`;
const clientB = `mcprate-b-${suffix}`;
const tokenA = `mcprate-token-a-${randomUUID()}`;
const tokenB = `mcprate-token-b-${randomUUID()}`;

describe.skipIf(!DB_URL)("MCP rate limiting", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let resolveMcpAuth: typeof import("./rpc").resolveMcpAuth;
  let handleMcpMessage: typeof import("./rpc").handleMcpMessage;
  let checkMcpRequestQuota: typeof import("./rpc").checkMcpRequestQuota;
  let consumeQuota: typeof import("@/lib/rate-limit").consumeQuota;
  let QUOTAS: typeof import("@/lib/rate-limit").QUOTAS;

  /** A request as an OAuth-connected MCP client makes it. */
  function request(token: string): Request {
    return new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-org-slug": workspace.slug,
      },
    });
  }

  /** Call `tool` over the RPC surface and return the text the agent sees. */
  async function callTool(token: string, tool: string): Promise<string> {
    const auth = await resolveMcpAuth(request(token));
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: {} },
      },
      auth,
    );
    const result = res?.result as { content?: { text: string }[] } | undefined;
    return result?.content?.[0]?.text ?? "";
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ resolveMcpAuth, handleMcpMessage, checkMcpRequestQuota } = await import(
      "./rpc"
    ));
    ({ consumeQuota, QUOTAS } = await import("@/lib/rate-limit"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'MCP Rate', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Agent Owner', ${`rate-${suffix}@mcp.test`})`;
    // Owner, so nothing below is refused for lack of product write access.
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;
    await sql`insert into oauth_applications (client_id, name, redirect_urls, type)
      values (${clientA}, 'Agent A', 'http://localhost/callback', 'public'),
             (${clientB}, 'Agent B', 'http://localhost/callback', 'public')`;
    const expires = new Date(Date.now() + 3_600_000);
    await sql`insert into oauth_access_tokens
        (access_token, refresh_token, access_token_expires_at,
         refresh_token_expires_at, client_id, user_id, scopes)
      values
        (${tokenA}, ${`${tokenA}-r`}, ${expires}, ${expires},
         ${clientA}, ${userId}, ''),
        (${tokenB}, ${`${tokenB}-r`}, ${expires}, ${expires},
         ${clientB}, ${userId}, '')`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await sql`delete from operation_limits where key like ${`%${suffix}%`}`;
    await sql`delete from oauth_access_tokens where user_id = ${userId}`;
    await sql`delete from oauth_applications
      where client_id in (${clientA}, ${clientB})`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("resolves an OAuth token to a per-connection credential key", async () => {
    const auth = await resolveMcpAuth(request(tokenA));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    // Per connection, not per user: the client id is in the key. This is the
    // property that keeps one runaway agent from starving its owner's others.
    expect(auth.ctx.credentialKey).toBe(`oauth:${clientA}:${userId}`);
    expect(auth.ctx.role).toBe("owner");
  });

  it("charges a batch its call count, not one request", async () => {
    const auth = await resolveMcpAuth(request(tokenA));
    const { limit } = QUOTAS.mcpRequest;

    // A 50-call batch, the endpoint's MAX_BATCH, costs 50 of the budget.
    expect(await checkMcpRequestQuota(auth, 50)).toBeNull();
    const [row] = await sql<{ count: number }[]>`
      select count from operation_limits
      where key = ${`mcp-request:oauth:${clientA}:${userId}`}`;
    expect(row?.count).toBe(50);

    // Spend the rest of the window's budget, then the next call is refused with
    // a retry delay the client can act on.
    expect(await checkMcpRequestQuota(auth, limit - 50)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retryAfter = await checkMcpRequestQuota(auth, 1);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(QUOTAS.mcpRequest.windowSec);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[security:rate-limit-exceeded]"),
    );
  });

  it("gives two connections of one user independent budgets", async () => {
    // Client A is exhausted by the test above. Client B, same user, is not.
    const authA = await resolveMcpAuth(request(tokenA));
    const authB = await resolveMcpAuth(request(tokenB));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await checkMcpRequestQuota(authA, 1)).toBeGreaterThan(0);
    expect(await checkMcpRequestQuota(authB, 1)).toBeNull();
  });

  it("refuses a git-committing tool once the write budget is spent", async () => {
    const key = `mcp-write:oauth:${clientB}:${userId}`;
    // Pre-spend the window rather than issuing 60 real calls: the assertion is
    // about the gate, not about how the counter got there.
    await consumeQuota(
      db,
      key,
      QUOTAS.mcpWrite.limit,
      QUOTAS.mcpWrite.windowSec,
      QUOTAS.mcpWrite.limit,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const text = await callTool(tokenB, "create_spec");
    expect(text).toContain("Rate limit");
    // The refusal has to tell the agent what to do next, not just say no.
    expect(text).toMatch(/Wait \d+s/);
    expect(text).toContain("reads are unaffected");
  });

  it("leaves reads and non-committing writes alone when only writes are spent", async () => {
    // Same exhausted mcp-write budget as above, still in its window.
    const listed = await callTool(tokenB, "list_items");
    expect(listed).not.toContain("Rate limit");
    // `update_item` mutates but does not commit, so it is not on that budget.
    expect(await callTool(tokenB, "update_item")).not.toContain("Rate limit");
  });
});
