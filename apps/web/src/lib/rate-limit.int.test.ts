import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { consumeQuota } from "./rate-limit";

/**
 * Fixed-window quota counter (docs/security-fixes.md, P2 per-workspace quotas
 * on expensive endpoints). Runs against DATABASE_URL; skips without one.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("consumeQuota", () => {
  let sql: postgres.Sql;
  let db: import("@specboard/db").Database;
  const key = `test-quota-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const { createDb } = await import("@specboard/db");
    db = createDb(DB_URL!);
    sql = postgres(DB_URL!, { prepare: false, max: 1 });
  });

  afterAll(async () => {
    await sql`delete from operation_limits where key like ${"test-quota-%"}`;
    await sql.end({ timeout: 5 });
  });

  it("allows up to the limit, then blocks with a retry-after", async () => {
    const limit = 3;
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await consumeQuota(db, key, limit, 60));
    }
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3]?.ok).toBe(false);
    expect(results[4]?.ok).toBe(false);
    expect(results[3]?.retryAfter).toBeGreaterThan(0);
    expect(results[3]?.retryAfter).toBeLessThanOrEqual(60);
  });

  it("resets once the window has elapsed", async () => {
    const k = `test-quota-window-${randomUUID().slice(0, 8)}`;
    // windowSec 0 means the stored window is always already in the past, so
    // every call resets the counter to 1 and stays allowed.
    const a = await consumeQuota(db, k, 1, 0);
    const b = await consumeQuota(db, k, 1, 0);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("counts each key independently", async () => {
    const k1 = `test-quota-a-${randomUUID().slice(0, 8)}`;
    const k2 = `test-quota-b-${randomUUID().slice(0, 8)}`;
    expect((await consumeQuota(db, k1, 1, 60)).ok).toBe(true);
    expect((await consumeQuota(db, k1, 1, 60)).ok).toBe(false);
    // A different key is unaffected by k1 being exhausted.
    expect((await consumeQuota(db, k2, 1, 60)).ok).toBe(true);
  });
});
