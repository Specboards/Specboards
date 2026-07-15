import { type Database } from "@specboard/db";

import { decryptSecret } from "@/lib/crypto";
import { getWorkerDb } from "@/lib/db";
import { relayOutbox } from "@/lib/webhooks/relay";
import { postSignedEnvelope } from "@/lib/webhooks/sender";
import {
  claimDueDeliveries,
  endpointDeliveryTarget,
  markDelivered,
  markFailed,
  markRetry,
  pruneProcessedOutbox,
  recordEndpointFailure,
  resetEndpointFailures,
  type ClaimedDelivery,
} from "@/lib/webhooks/store";
import { WEBHOOK_FAILURE_DISABLE_THRESHOLD } from "@/lib/webhooks/types";

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

// Outbox retention: processed events older than this are pruned hourly so the
// table doesn't grow without bound (a row is written per item/release change,
// regardless of whether any endpoint is subscribed). Configurable; 0 disables.
const RETENTION_DAYS = readRetentionDays();
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000; // hourly
const PRUNE_BATCH = 500;
const PRUNE_MAX_PER_SWEEP = 50_000; // bound a single sweep's work

function readRetentionDays(): number {
  const raw = process.env.SPECBOARD_OUTBOX_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

let interval: ReturnType<typeof setInterval> | null = null;
let draining = false;
let rerun = false;
let soonScheduled = false;

/** Start the periodic sweeps once per process. No-op in local file mode. */
export function startDrainer(): void {
  if (interval) return;
  if (!getWorkerDb()) return;
  interval = setInterval(() => void drainOnce(), INTERVAL_MS);
  // Kick shortly after boot to flush anything left pending across a restart.
  setTimeout(() => void drainOnce(), 2_000);
  if (RETENTION_DAYS > 0) {
    setInterval(() => void pruneOnce(), PRUNE_INTERVAL_MS);
    setTimeout(() => void pruneOnce(), 60_000); // first prune a minute after boot
  }
}

/** Delete processed outbox events past the retention window, in bounded batches. */
export async function pruneOnce(): Promise<void> {
  if (RETENTION_DAYS <= 0) return;
  const db = getWorkerDb();
  if (!db) return;
  try {
    let total = 0;
    let deleted = 0;
    do {
      deleted = await pruneProcessedOutbox(db, RETENTION_DAYS, PRUNE_BATCH);
      total += deleted;
    } while (deleted === PRUNE_BATCH && total < PRUNE_MAX_PER_SWEEP);
    if (total > 0) {
      console.log(`[webhooks] pruned ${total} processed outbox events`);
    }
  } catch (err) {
    console.error("[webhooks] outbox prune failed:", err);
  }
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
  const db = getWorkerDb();
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
    // Endpoint is already off/gone: fail the row but don't touch the streak.
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
    await resetEndpointFailures(db, d.endpointId);
    return;
  }

  let terminal: boolean;
  if (result.blocked) {
    // A URL that fails the SSRF check is terminal, not worth retrying.
    await markFailed(db, d.id, null, `Blocked URL: ${result.error}`);
    terminal = true;
  } else {
    terminal = await retryOrFail(db, d, result.statusCode, result.error);
  }

  // Only a give-up (retry budget exhausted, or terminal block) counts toward
  // auto-disable; an intermediate retry leaves the streak untouched.
  if (terminal) await recordEndpointFailureAndLog(db, d.endpointId);
}

async function recordEndpointFailureAndLog(
  db: Database,
  endpointId: string,
): Promise<void> {
  const disabled = await recordEndpointFailure(db, endpointId);
  if (disabled) {
    console.log(
      `[webhooks] auto-disabled endpoint ${endpointId} after ${WEBHOOK_FAILURE_DISABLE_THRESHOLD} consecutive failures`,
    );
  }
}

/**
 * Schedule the next retry, or give up when the backoff schedule is exhausted.
 * Returns true if this was the terminal give-up (row marked `failed`).
 */
async function retryOrFail(
  db: Database,
  d: ClaimedDelivery,
  statusCode: number | null,
  error: string,
): Promise<boolean> {
  // `d.attempts` was already incremented when the row was claimed.
  const delay = BACKOFF_SECONDS[d.attempts - 1];
  if (delay === undefined) {
    await markFailed(db, d.id, statusCode, error);
    return true;
  }
  await markRetry(db, d.id, new Date(Date.now() + delay * 1_000), statusCode, error);
  return false;
}
