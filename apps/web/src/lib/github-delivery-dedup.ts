import { githubWebhookDeliveries, lt, sql, type Database } from "@specboards/db";

import { logSecurityEvent } from "@/lib/security-log";

/**
 * Process each GitHub webhook delivery once.
 *
 * The handler verifies the HMAC over the raw body, but a valid signature says
 * "GitHub sent this", not "GitHub sent this for the first time". Nothing
 * recorded which deliveries had been handled, so a signed delivery could be
 * replayed - captured in transit, or re-sent from GitHub's own redelivery UI -
 * and the sync path would run again. GitHub retries on its own too, so
 * duplicate processing was never purely adversarial.
 *
 * The insert IS the check. Claiming the id and processing only if the claim
 * succeeded means two concurrent copies of the same delivery cannot both
 * proceed; a `SELECT` then `INSERT` would let both read "not seen" first.
 */

/**
 * How long a delivery id is remembered. GitHub's retry schedule is measured in
 * hours, so a day is comfortably clear of it while keeping the table small.
 */
const RETENTION_HOURS = 24;

/** Prune roughly this often, as a fraction of calls. */
const PRUNE_PROBABILITY = 0.01;

type DeliveryClaim =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "missing-id" };

/**
 * Claim `deliveryId` for processing. `ok: true` means this call owns it and the
 * caller should go on to handle the delivery; anything else means stop.
 *
 * A missing or malformed id is refused rather than waved through. Before this
 * existed the header was optional in practice (it was only ever logged), but a
 * delivery that cannot be deduplicated is one that can be replayed, and every
 * genuine GitHub delivery carries one.
 */
export async function claimDelivery(
  db: Database,
  deliveryId: string | null,
): Promise<DeliveryClaim> {
  const id = deliveryId?.trim();
  if (!id || id.length > 200) {
    logSecurityEvent("webhook-delivery-id-missing", {
      endpoint: "github-webhook",
      // Length only: the value is attacker-supplied and does not belong in logs.
      length: deliveryId?.length ?? 0,
    });
    return { ok: false, reason: "missing-id" };
  }

  const claimed = await db
    .insert(githubWebhookDeliveries)
    .values({ deliveryId: id })
    .onConflictDoNothing({ target: githubWebhookDeliveries.deliveryId })
    .returning({ deliveryId: githubWebhookDeliveries.deliveryId });

  if (claimed.length === 0) {
    logSecurityEvent("webhook-delivery-replayed", {
      endpoint: "github-webhook",
      delivery: id,
    });
    return { ok: false, reason: "duplicate" };
  }

  return { ok: true };
}

/**
 * Drop delivery ids past the retention window.
 *
 * Sampled rather than scheduled: this runs inside a webhook request, and the
 * sink has no cron of its own. At 1% of deliveries the table stays bounded on
 * any repo busy enough to matter, and a quiet deployment carrying a few stale
 * rows costs nothing. Failures are swallowed - a delivery must not be rejected
 * because housekeeping did not work.
 */
export async function pruneDeliveries(db: Database, force = false): Promise<void> {
  if (!force && Math.random() > PRUNE_PROBABILITY) return;
  try {
    await db
      .delete(githubWebhookDeliveries)
      .where(
        lt(
          githubWebhookDeliveries.receivedAt,
          sql`now() - make_interval(hours => ${RETENTION_HOURS})`,
        ),
      );
  } catch (err) {
    console.warn(`[github-webhook] delivery prune failed: ${(err as Error).message}`);
  }
}
