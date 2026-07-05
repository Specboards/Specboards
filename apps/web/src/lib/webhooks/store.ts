import {
  and,
  desc,
  eq,
  sql,
  type Database,
  webhookDeliveries,
  webhookEndpoints,
} from "@specboard/db";

import { encryptSecret } from "@/lib/crypto";
import type { WebhookEnvelope } from "@/lib/webhooks/types";

/**
 * Data access for outbound webhooks. Standalone (like `api-keys.ts`), taking a
 * raw `Database`: endpoint CRUD runs on the request connection, while the
 * delivery drainer runs on the owner connection since it spans every workspace.
 * The signing `secret` is stored `encryptSecret`'d (two-way, reused to sign) and
 * never returned by the list/summary reads.
 */

/** Endpoint view for the settings UI: everything except the signing secret. */
export type WebhookEndpointSummary = {
  id: string;
  url: string;
  productId: string | null;
  eventTypes: string[];
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function toSummary(row: typeof webhookEndpoints.$inferSelect): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    productId: row.productId,
    eventTypes: row.eventTypes,
    description: row.description,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listEndpoints(
  db: Database,
  workspaceId: string,
): Promise<WebhookEndpointSummary[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspaceId))
    .orderBy(desc(webhookEndpoints.createdAt));
  return rows.map(toSummary);
}

export async function createEndpoint(
  db: Database,
  input: {
    workspaceId: string;
    productId: string | null;
    url: string;
    /** Plaintext signing secret; encrypted here, shown to the admin once by the caller. */
    secret: string;
    eventTypes: string[];
    description: string | null;
  },
): Promise<WebhookEndpointSummary> {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      workspaceId: input.workspaceId,
      productId: input.productId,
      url: input.url,
      secret: encryptSecret(input.secret),
      eventTypes: input.eventTypes,
      description: input.description,
    })
    .returning();
  return toSummary(row!);
}

export async function updateEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
  patch: {
    active?: boolean;
    eventTypes?: string[];
    description?: string | null;
    url?: string;
    productId?: string | null;
  },
): Promise<WebhookEndpointSummary | null> {
  const set: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.eventTypes !== undefined) set.eventTypes = patch.eventTypes;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.productId !== undefined) set.productId = patch.productId;

  const [row] = await db
    .update(webhookEndpoints)
    .set(set)
    .where(
      and(
        eq(webhookEndpoints.id, id),
        eq(webhookEndpoints.workspaceId, workspaceId),
      ),
    )
    .returning();
  return row ? toSummary(row) : null;
}

export async function deleteEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, id),
        eq(webhookEndpoints.workspaceId, workspaceId),
      ),
    )
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}

/** The full endpoint row (incl. encrypted secret), scoped to a workspace. */
export async function getEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<typeof webhookEndpoints.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, id),
        eq(webhookEndpoints.workspaceId, workspaceId),
      ),
    );
  return row ?? null;
}

/**
 * The delivery target for a claimed row: the endpoint's URL, encrypted secret,
 * and active flag. Not workspace-scoped because the drainer is a system process
 * that already holds the delivery row (whose endpoint FK cascade-deletes with
 * the endpoint, so a present row implies a present endpoint).
 */
export async function endpointDeliveryTarget(
  db: Database,
  endpointId: string,
): Promise<{ url: string; secret: string; active: boolean } | null> {
  const [row] = await db
    .select({
      url: webhookEndpoints.url,
      secret: webhookEndpoints.secret,
      active: webhookEndpoints.active,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, endpointId));
  return row ?? null;
}

export type ClaimedDelivery = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: WebhookEnvelope;
  attempts: number;
};

/**
 * Lease up to `limit` due deliveries: pick `pending` rows whose `nextAttemptAt`
 * has passed, skip ones another drainer holds (`FOR UPDATE SKIP LOCKED`), bump
 * `attempts`, and push `nextAttemptAt` out by `leaseSeconds` so a crash mid-POST
 * makes the row due again (at-least-once; consumers dedupe on the envelope id).
 * The POST happens outside this short transaction so no HTTP call holds a lock.
 */
export async function claimDueDeliveries(
  db: Database,
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedDelivery[]> {
  // postgres-js `db.execute` resolves to the row list directly (not `{ rows }`).
  const result = await db.execute(sql`
    WITH due AS (
      SELECT id FROM webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE webhook_deliveries d
    SET attempts = d.attempts + 1,
        next_attempt_at = now() + (${leaseSeconds} * interval '1 second')
    FROM due
    WHERE d.id = due.id
    RETURNING d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts
  `);
  const rows = result as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    eventId: r.event_id as string,
    eventType: r.event_type as string,
    payload: r.payload as WebhookEnvelope,
    attempts: Number(r.attempts),
  }));
}

export async function markDelivered(
  db: Database,
  id: string,
  statusCode: number,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: "delivered",
      nextAttemptAt: null,
      lastStatusCode: statusCode,
      lastError: null,
    })
    .where(eq(webhookDeliveries.id, id));
}

/** Schedule the next retry (still `pending`), recording why the last try failed. */
export async function markRetry(
  db: Database,
  id: string,
  nextAttemptAt: Date,
  statusCode: number | null,
  error: string,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      nextAttemptAt,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
    })
    .where(eq(webhookDeliveries.id, id));
}

/** Give up: mark `failed` after the retry budget is exhausted. */
export async function markFailed(
  db: Database,
  id: string,
  statusCode: number | null,
  error: string,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: "failed",
      nextAttemptAt: null,
      lastStatusCode: statusCode,
      lastError: error.slice(0, 500),
    })
    .where(eq(webhookDeliveries.id, id));
}
