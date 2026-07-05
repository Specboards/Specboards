import { type Database } from "@specboard/db";

import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { relayOutbox } from "@/lib/webhooks/relay";
import { postSignedEnvelope } from "@/lib/webhooks/sender";
import {
  claimDueDeliveries,
  endpointDeliveryTarget,
  markDelivered,
  markFailed,
  markRetry,
  type ClaimedDelivery,
} from "@/lib/webhooks/store";

/**
 * In-process outbox drainer. It claims due `webhook_deliveries` rows, POSTs the
 * signed envelope to each endpoint, and records the outcome with exponential
 * backoff. Runs on a `setInterval` started once at server boot
 * (`instrumentation.ts`) plus an opportunistic kick right after a dispatch, so
 * healthy deliveries go out in ~a tick rather than waiting for the next sweep.
 *
 * One Fly machine today, so a single loop suffices; `FOR UPDATE SKIP LOCKED` in
 * the claim keeps it correct if we ever scale to >1 instance.
 */

const INTERVAL_MS = 30_000;
const CLAIM_LIMIT = 20;
const LEASE_SECONDS = 120; // visibility timeout: a crashed POST re-becomes due after this
/** Backoff after the Nth failed attempt (1-indexed); past the end = give up. */
const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600]; // 1m, 5m, 30m, 2h, 6h

let interval: ReturnType<typeof setInterval> | null = null;
let draining = false;
let rerun = false;
let soonScheduled = false;

/** Start the periodic sweep once per process. No-op in local file mode. */
export function startDrainer(): void {
  if (interval) return;
  if (!getDb()) return;
  interval = setInterval(() => void drainOnce(), INTERVAL_MS);
  // Kick shortly after boot to flush anything left pending across a restart.
  setTimeout(() => void drainOnce(), 2_000);
}

/** Coalesced nudge used by `dispatchEvent` so a burst of events drains once. */
export function drainSoon(): void {
  if (soonScheduled) return;
  soonScheduled = true;
  setTimeout(() => {
    soonScheduled = false;
    void drainOnce();
  }, 50);
}

/**
 * One drain pass. Guarded so overlapping triggers (interval + opportunistic
 * kicks) never run concurrently; a trigger arriving mid-pass sets `rerun` so we
 * immediately sweep again, which drains a backlog larger than one batch.
 */
export async function drainOnce(): Promise<void> {
  if (draining) {
    rerun = true;
    return;
  }
  const db = getDb();
  if (!db) return;

  draining = true;
  try {
    // First expand any new outbox events into per-endpoint delivery rows, then
    // send everything that's due.
    await relayOutbox();
    const claimed = await claimDueDeliveries(db, CLAIM_LIMIT, LEASE_SECONDS);
    await Promise.all(claimed.map((d) => deliverOne(db, d)));
    // A full batch likely means more is waiting; sweep again next tick.
    if (claimed.length === CLAIM_LIMIT) rerun = true;
  } catch (err) {
    console.error("[webhooks] drain pass failed:", err);
  } finally {
    draining = false;
    if (rerun) {
      rerun = false;
      setTimeout(() => void drainOnce(), 0);
    }
  }
}

async function deliverOne(db: Database, d: ClaimedDelivery): Promise<void> {
  const target = await endpointDeliveryTarget(db, d.endpointId);
  if (!target || !target.active) {
    await markFailed(db, d.id, null, "Endpoint is inactive or was removed.");
    return;
  }

  const result = await postSignedEnvelope(
    target.url,
    decryptSecret(target.secret),
    d.payload,
  );

  if (result.ok) {
    await markDelivered(db, d.id, result.statusCode);
  } else if (result.blocked) {
    // A URL that fails the SSRF check is terminal, not worth retrying.
    await markFailed(db, d.id, null, `Blocked URL: ${result.error}`);
  } else {
    await retryOrFail(db, d, result.statusCode, result.error);
  }
}

async function retryOrFail(
  db: Database,
  d: ClaimedDelivery,
  statusCode: number | null,
  error: string,
): Promise<void> {
  // `d.attempts` was already incremented when the row was claimed.
  const delay = BACKOFF_SECONDS[d.attempts - 1];
  if (delay === undefined) {
    await markFailed(db, d.id, statusCode, error);
    return;
  }
  await markRetry(db, d.id, new Date(Date.now() + delay * 1_000), statusCode, error);
}
