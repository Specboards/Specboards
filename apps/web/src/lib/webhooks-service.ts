import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, type Database, products, workspaces } from "@specboard/db";

import { decryptSecret } from "@/lib/crypto";
import { drainSoon } from "@/lib/webhooks/drainer";
import { postSignedEnvelope, type SendResult } from "@/lib/webhooks/sender";
import { assertPublicUrl } from "@/lib/webhooks/ssrf";
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  requeueDelivery,
  updateEndpoint,
  type WebhookDeliverySummary,
  type WebhookEndpointSummary,
} from "@/lib/webhooks/store";
import {
  isWebhookEventType,
  type WebhookEnvelope,
  type WebhookEventType,
} from "@/lib/webhooks/types";

/** A bad request body (invalid URL, unknown event type, etc.). Routes map to 422. */
export class WebhookInputError extends Error {}

export type CreatedEndpoint = {
  endpoint: WebhookEndpointSummary;
  /** Plaintext signing secret, shown to the admin exactly once. */
  secret: string;
};

function parseEventTypes(v: unknown): WebhookEventType[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new WebhookInputError("Select at least one event type.");
  }
  const out: WebhookEventType[] = [];
  for (const item of v) {
    if (!isWebhookEventType(item)) {
      throw new WebhookInputError(`Unknown event type: ${String(item)}`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

async function validateUrl(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new WebhookInputError("A delivery URL is required.");
  }
  const url = raw.trim();
  const check = await assertPublicUrl(url);
  if (!check.ok) throw new WebhookInputError(check.reason);
  return url;
}

/** Ensure a product id (if given) belongs to this workspace; null = all products. */
async function validateProductId(
  db: Database,
  workspaceId: string,
  raw: unknown,
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new WebhookInputError("Invalid product.");
  }
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, raw), eq(products.workspaceId, workspaceId)));
  if (!row) throw new WebhookInputError("Unknown product for this workspace.");
  return raw;
}

function parseDescription(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new WebhookInputError("Invalid description.");
  return v.trim().slice(0, 200) || null;
}

export function listWebhookEndpoints(
  db: Database,
  workspaceId: string,
): Promise<WebhookEndpointSummary[]> {
  return listEndpoints(db, workspaceId);
}

export async function createWebhookEndpoint(
  db: Database,
  workspaceId: string,
  body: unknown,
): Promise<CreatedEndpoint> {
  const b = (body ?? {}) as Record<string, unknown>;
  const url = await validateUrl(b.url);
  const eventTypes = parseEventTypes(b.eventTypes);
  const productId = await validateProductId(db, workspaceId, b.productId);
  const description = parseDescription(b.description);

  // Generate the signing secret server-side; shown to the admin exactly once.
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const endpoint = await createEndpoint(db, {
    workspaceId,
    productId,
    url,
    secret,
    eventTypes,
    description,
  });
  return { endpoint, secret };
}

export async function updateWebhookEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
  body: unknown,
): Promise<WebhookEndpointSummary | null> {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: {
    active?: boolean;
    eventTypes?: WebhookEventType[];
    description?: string | null;
    url?: string;
    productId?: string | null;
  } = {};

  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") {
      throw new WebhookInputError("`active` must be a boolean.");
    }
    patch.active = b.active;
  }
  if (b.eventTypes !== undefined) patch.eventTypes = parseEventTypes(b.eventTypes);
  if (b.description !== undefined) patch.description = parseDescription(b.description);
  if (b.url !== undefined) patch.url = await validateUrl(b.url);
  if (b.productId !== undefined) {
    patch.productId = await validateProductId(db, workspaceId, b.productId);
  }

  return updateEndpoint(db, workspaceId, id, patch);
}

export function deleteWebhookEndpoint(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  return deleteEndpoint(db, workspaceId, id);
}

/** Max delivery-log rows returned per endpoint in the settings UI. */
const DELIVERY_LOG_LIMIT = 50;

/**
 * Recent deliveries for an endpoint (newest first), for the settings delivery
 * log. Returns null if the endpoint isn't in this workspace.
 */
export async function listWebhookDeliveries(
  db: Database,
  workspaceId: string,
  endpointId: string,
): Promise<WebhookDeliverySummary[] | null> {
  const ep = await getEndpoint(db, workspaceId, endpointId);
  if (!ep) return null;
  return listDeliveries(db, workspaceId, endpointId, DELIVERY_LOG_LIMIT);
}

/**
 * Re-queue one past delivery for an immediate resend. Returns false if the
 * (endpoint, delivery) pair isn't in this workspace. Kicks the drainer so the
 * resend leaves on the next tick rather than the next sweep.
 */
export async function redeliverWebhookDelivery(
  db: Database,
  workspaceId: string,
  endpointId: string,
  deliveryId: string,
): Promise<boolean> {
  const requeued = await requeueDelivery(db, workspaceId, endpointId, deliveryId);
  if (requeued) drainSoon();
  return requeued;
}

/**
 * Send a representative test delivery to an endpoint and report the result
 * synchronously (bypasses the outbox so the admin gets immediate feedback).
 * Returns `null` if the endpoint isn't found in this workspace.
 */
export async function sendTestEvent(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<SendResult | null> {
  const ep = await getEndpoint(db, workspaceId, id);
  if (!ep) return null;

  const [ws] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  const type: WebhookEventType =
    (ep.eventTypes.find(isWebhookEventType) as WebhookEventType | undefined) ??
    "item.status_changed";

  const envelope: WebhookEnvelope = {
    id: `evt_test_${randomUUID().replace(/-/g, "")}`,
    type,
    occurredAt: new Date().toISOString(),
    workspace: { id: workspaceId, slug: ws?.slug ?? "" },
    product: null,
    data: {
      test: true,
      message: "This is a test delivery from Specboards.",
    },
  };

  return postSignedEnvelope(ep.url, decryptSecret(ep.secret), envelope);
}
