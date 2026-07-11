import { operationLimits, sql, type Database } from "@specboard/db";

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
 * Atomically count one request against `key`'s fixed window and report whether
 * it's within `limit`. The whole check-and-increment is a single upsert, so
 * concurrent requests can't all read a stale count and slip past. When the
 * stored window has expired the counter resets to 1; otherwise it increments.
 */
export async function consumeQuota(
  db: Database,
  key: string,
  limit: number,
  windowSec: number,
): Promise<QuotaResult> {
  const [row] = await db
    .insert(operationLimits)
    .values({ key, count: 1, windowStart: sql`now()` })
    .onConflictDoUpdate({
      target: operationLimits.key,
      set: {
        count: sql`case
          when ${operationLimits.windowStart} < now() - make_interval(secs => ${windowSec})
          then 1 else ${operationLimits.count} + 1 end`,
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
  if (!db) return null;
  const result = await consumeQuota(
    db,
    `${quota.op}:${scopeId}`,
    quota.limit,
    quota.windowSec,
  );
  if (result.ok) return null;

  logSecurityEvent("rate-limit-exceeded", {
    op: quota.op,
    scope: scopeId,
    limit: quota.limit,
    windowSec: quota.windowSec,
    retryAfter: result.retryAfter,
  });
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
} as const satisfies Record<string, Quota>;
