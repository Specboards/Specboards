import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  isNull,
  or,
  sql,
  outboxEvents,
  products,
  users,
  webhookDeliveries,
  webhookEndpoints,
  workspaces,
  type Database,
} from "@specboard/db";

import { getWorkerDb } from "@/lib/db";
import type { WebhookEnvelope, WebhookEventType } from "@/lib/webhooks/types";

/**
 * Outbox relay: turns durable `outbox_events` rows (written in the same
 * transaction as the domain change) into per-endpoint `webhook_deliveries`. Each
 * event is claimed and expanded in its own transaction with `FOR UPDATE SKIP
 * LOCKED`, so the delivery rows and the `processedAt` stamp commit together
 * (a crash mid-expansion leaves the event unprocessed and it's retried) and
 * concurrent relays never double-fan-out. The actual HTTP POST is the delivery
 * drainer's job; this stage only enqueues.
 *
 * The outbox snapshot was written to match the webhook payload fields, so
 * mapping is a pass-through: `envelope.data = { ...event.data, actor }`.
 */

const BATCH = 50;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function relayOutbox(): Promise<void> {
  const db = getWorkerDb();
  if (!db) return;

  // Candidate ids (unlocked read); each is then claimed + expanded in its own tx.
  const candidates = await db
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(isNull(outboxEvents.processedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(BATCH);

  for (const { id } of candidates) {
    await db.transaction((tx) => expandOne(tx, id));
  }
}

async function expandOne(tx: Tx, id: string): Promise<void> {
  // Re-claim under a row lock; skip if another relay took it or it's already done.
  const [ev] = await tx
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.processedAt)))
    .for("update", { skipLocked: true })
    .limit(1);
  if (!ev) return;

  const productMatch =
    ev.productId === null
      ? isNull(webhookEndpoints.productId)
      : or(
          isNull(webhookEndpoints.productId),
          eq(webhookEndpoints.productId, ev.productId),
        );
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.workspaceId, ev.workspaceId),
        eq(webhookEndpoints.active, true),
        sql`${ev.type} = ANY(${webhookEndpoints.eventTypes})`,
        productMatch,
      ),
    );

  if (endpoints.length > 0) {
    const [workspace, product, actor] = await Promise.all([
      loadWorkspace(tx, ev.workspaceId),
      ev.productId ? loadProduct(tx, ev.productId) : Promise.resolve(null),
      ev.actorId ? loadActor(tx, ev.actorId) : Promise.resolve(null),
    ]);

    if (workspace) {
      const data = { ...(ev.data as Record<string, unknown>), actor };
      const rows = endpoints.map((ep) => {
        const eventId = `evt_${randomUUID().replace(/-/g, "")}`;
        const payload: WebhookEnvelope = {
          id: eventId,
          type: ev.type as WebhookEventType,
          occurredAt: ev.createdAt.toISOString(),
          workspace: { id: workspace.id, slug: workspace.slug },
          product,
          data,
        };
        return {
          endpointId: ep.id,
          workspaceId: ev.workspaceId,
          eventId,
          eventType: ev.type,
          payload,
        };
      });
      await tx.insert(webhookDeliveries).values(rows);
    }
  }

  await tx
    .update(outboxEvents)
    .set({ processedAt: new Date() })
    .where(eq(outboxEvents.id, ev.id));
}

async function loadWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<{ id: string; slug: string } | null> {
  const [row] = await tx
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row ?? null;
}

async function loadProduct(
  tx: Tx,
  productId: string,
): Promise<{ id: string; key: string; name: string } | null> {
  const [row] = await tx
    .select({ id: products.id, key: products.key, name: products.name })
    .from(products)
    .where(eq(products.id, productId));
  return row ?? null;
}

async function loadActor(
  tx: Tx,
  actorId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, actorId));
  return row ? { id: row.id, name: row.name } : null;
}
