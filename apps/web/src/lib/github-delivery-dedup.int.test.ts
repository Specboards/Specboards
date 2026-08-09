import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Delivery-id dedup for the GitHub webhook sink.
 *
 * A valid HMAC says GitHub sent the delivery, not that GitHub sent it for the
 * first time. Nothing recorded which deliveries had been handled, so a signed
 * delivery could be replayed (captured, or re-sent from GitHub's redelivery UI)
 * and the sync path would run again.
 *
 * These run against Postgres rather than a mock because the whole mechanism is
 * one `INSERT ... ON CONFLICT DO NOTHING`: the interesting behaviour is what
 * the database does under a real primary-key conflict, which a fake would only
 * restate.
 *
 * Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("claimDelivery", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let claimDelivery: typeof import("./github-delivery-dedup").claimDelivery;
  let pruneDeliveries: typeof import("./github-delivery-dedup").pruneDeliveries;
  const created: string[] = [];

  /** A delivery id shaped like GitHub's, unique per test. */
  function newId(): string {
    const id = `dedup-test-${randomUUID()}`;
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ claimDelivery, pruneDeliveries } = await import("./github-delivery-dedup"));
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
  });

  afterEach(async () => {
    if (created.length) {
      await sql`delete from github_webhook_deliveries where delivery_id = any(${created})`;
      created.length = 0;
    }
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("claims a delivery the first time", async () => {
    expect(await claimDelivery(db, newId())).toEqual({ ok: true });
  });

  it("refuses the same delivery the second time", async () => {
    const id = newId();
    expect(await claimDelivery(db, id)).toEqual({ ok: true });
    expect(await claimDelivery(db, id)).toEqual({ ok: false, reason: "duplicate" });
    // And a third, so this is not a one-shot toggle.
    expect(await claimDelivery(db, id)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("claims exactly once under concurrency", async () => {
    // The reason the insert is the check rather than SELECT-then-INSERT: two
    // concurrent copies of the same delivery would both read "not seen".
    const id = newId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimDelivery(db, id)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
  });

  it("keeps distinct deliveries independent", async () => {
    expect(await claimDelivery(db, newId())).toEqual({ ok: true });
    expect(await claimDelivery(db, newId())).toEqual({ ok: true });
  });

  it("refuses a missing or unusable delivery id", async () => {
    for (const id of [null, "", "   "]) {
      expect(await claimDelivery(db, id), JSON.stringify(id)).toEqual({
        ok: false,
        reason: "missing-id",
      });
    }
    // Absurdly long ids are refused rather than stored: the value is
    // attacker-supplied and every real one is a UUID.
    expect(await claimDelivery(db, "x".repeat(201))).toEqual({
      ok: false,
      reason: "missing-id",
    });
  });

  it("prunes past the retention window but keeps recent ids", async () => {
    const old = newId();
    const recent = newId();
    expect(await claimDelivery(db, old)).toEqual({ ok: true });
    expect(await claimDelivery(db, recent)).toEqual({ ok: true });
    await sql`update github_webhook_deliveries
      set received_at = now() - interval '48 hours' where delivery_id = ${old}`;

    await pruneDeliveries(db, true);

    const rows = await sql<{ delivery_id: string }[]>`
      select delivery_id from github_webhook_deliveries
      where delivery_id in (${old}, ${recent})`;
    expect(rows.map((r) => r.delivery_id)).toEqual([recent]);

    // A pruned id is claimable again. That is the intended trade: retention is
    // well past GitHub's retry schedule, so anything arriving later is not a
    // retry we still need to suppress.
    expect(await claimDelivery(db, old)).toEqual({ ok: true });
  });
});
