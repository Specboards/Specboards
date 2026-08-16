import { operationLimits, sql, type Database } from "@specboards/db";

import { logSecurityEvent } from "@/lib/security-log";

/**
 * Per-scope fixed-window quotas for expensive API operations (repo scans,
 * imports, starter-spec commits, repo connects, webhook test sends). Better
 * Auth's limiter covers `/api/auth/*`; these endpoints are outside it and are
 * costly (GitHub API calls, git commits, outbound HTTP), so a signed-in owner
 * could hammer them. Counters live in Postgres (`operation_limits`) so the
 * limit holds across instances, unlike an in-process map.
 */

export interface QuotaResult {
  ok: boolean;
  /** Seconds until the window resets (only meaningful when `ok` is false). */
  retryAfter: number;
}

/**
 * Atomically count `cost` units against `key`'s fixed window and report whether
 * it's within `limit`. The whole check-and-increment is a single upsert, so
 * concurrent requests can't all read a stale count and slip past. When the
 * stored window has expired the counter resets to `cost`; otherwise it adds.
 *
 * `cost` exists because one HTTP request is not always one unit of work: a
 * JSON-RPC batch on `/api/mcp` carries up to 50 calls, and counting it as 1
 * would let a caller multiply its real quota by the batch size.
 */
export async function consumeQuota(
  db: Database,
  key: string,
  limit: number,
  windowSec: number,
  cost = 1,
): Promise<QuotaResult> {
  const [row] = await db
    .insert(operationLimits)
    .values({ key, count: cost, windowStart: sql`now()` })
    .onConflictDoUpdate({
      target: operationLimits.key,
      set: {
        count: sql`case
          when ${operationLimits.windowStart} < now() - make_interval(secs => ${windowSec})
          then ${cost} else ${operationLimits.count} + ${cost} end`,
        windowStart: sql`case
          when ${operationLimits.windowStart} < now() - make_interval(secs => ${windowSec})
          then now() else ${operationLimits.windowStart} end`,
      },
    })
    .returning({ count: operationLimits.count, windowStart: operationLimits.windowStart });

  if (!row) return { ok: true, retryAfter: 0 };
  if (row.count <= limit) return { ok: true, retryAfter: 0 };

  const elapsedMs = Date.now() - new Date(row.windowStart).getTime();
  const retryAfter = Math.max(1, Math.ceil(windowSec - elapsedMs / 1000));
  return { ok: false, retryAfter };
}

/** A named quota (limit per window), applied by {@link enforceQuota}. */
export interface Quota {
  op: string;
  limit: number;
  windowSec: number;
}

/**
 * Count `cost` units of `quota` against `scopeId` and report the outcome,
 * logging a security event when the quota is exhausted. No-op (always allowed)
 * when `db` is null: local file mode has no Postgres and no multi-tenant abuse
 * surface.
 *
 * Split out of {@link enforceQuota} for callers that cannot return an HTTP
 * `Response`. `/api/mcp` speaks JSON-RPC, and an MCP client reads the body, not
 * the status line, so it has to render its own refusal from this result.
 */
export async function checkQuota(
  db: Database | null,
  quota: Quota,
  scopeId: string,
  cost = 1,
): Promise<QuotaResult> {
  if (!db) return { ok: true, retryAfter: 0 };
  const result = await consumeQuota(
    db,
    `${quota.op}:${scopeId}`,
    quota.limit,
    quota.windowSec,
    cost,
  );
  if (result.ok) return result;

  logSecurityEvent("rate-limit-exceeded", {
    op: quota.op,
    scope: scopeId,
    limit: quota.limit,
    windowSec: quota.windowSec,
    cost,
    retryAfter: result.retryAfter,
  });
  return result;
}

/**
 * Enforce `quota` for `scopeId` (usually a workspace id). Returns `null` when
 * allowed, or a ready-to-return 429 `Response` (with `Retry-After`) when the
 * quota is exceeded, logging a security event. No-op when `db` is null (local
 * file mode has no Postgres and no multi-tenant abuse surface).
 */
export async function enforceQuota(
  db: Database | null,
  quota: Quota,
  scopeId: string,
): Promise<Response | null> {
  const result = await checkQuota(db, quota, scopeId);
  if (result.ok) return null;

  return Response.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
  );
}

/** Quota definitions for the expensive endpoints (per workspace). */
export const QUOTAS = {
  scan: { op: "scan", limit: 20, windowSec: 300 },
  import: { op: "import", limit: 10, windowSec: 1800 },
  starterSpec: { op: "starter-spec", limit: 20, windowSec: 3600 },
  connectRepo: { op: "connect-repo", limit: 30, windowSec: 3600 },
  webhookTest: { op: "webhook-test", limit: 30, windowSec: 3600 },
  /**
   * Blanket throttle on `/api/v1` requests made with an API key (per key). The
   * CLI and sync loop burst but stay well under this; it caps a leaked or
   * runaway key. Browser-session traffic is not counted here (it is human-paced
   * and Better Auth already limits the auth routes).
   */
  apiRequest: { op: "api-request", limit: 600, windowSec: 60 },
  /**
   * The public "Request access" intake, which is unauthenticated, CORS-open to
   * the marketing site, and sends TWO emails per accepted request (review inbox
   * + requester confirmation).
   *
   * Two quotas, because they stop different things. Per client (see
   * `lib/client-ip.ts`) caps one source hammering the form; per email address
   * caps a botnet with many IPs mailbombing one person, which the per-client
   * limit cannot see. Both are generous for a form a human fills in once.
   */
  accessRequest: { op: "access-request", limit: 5, windowSec: 3600 },
  accessRequestEmail: { op: "access-request-email", limit: 3, windowSec: 86_400 },
  /**
   * `/api/mcp`, counted per JSON-RPC call and keyed per credential (see
   * `lib/mcp/rpc.ts` `credentialKeyFor`), not per user: one runaway agent must
   * not be able to exhaust its owner's other connections.
   *
   * `apiRequest` does not cover this. It only ever ran on the bearer-key path,
   * incidentally, because that path shares the REST helper; an OAuth-connected
   * agent skipped it entirely. It is also the wrong unit here, since one HTTP
   * request can carry a batch of 50 calls.
   *
   * 600 calls/minute is 10/second sustained, which is far above what an agent
   * driving a board does and low enough to bound a runaway loop.
   */
  mcpRequest: { op: "mcp-request", limit: 600, windowSec: 60 },
  /**
   * The subset of MCP tools that write to git (those declaring `commits: true`
   * in `lib/mcp/types.ts`), counted per tool call rather than per HTTP request
   * so a batch cannot
   * smuggle 50 commits past a per-request counter. Each one is a GitHub API
   * round trip and a commit, so it is orders of magnitude more expensive than a
   * read and deserves its own, much tighter budget.
   *
   * 60 per 10 minutes covers an agent breaking a feature into a dozen child
   * specs and revising them, with room to spare.
   */
  mcpWrite: { op: "mcp-write", limit: 60, windowSec: 600 },
} as const satisfies Record<string, Quota>;
