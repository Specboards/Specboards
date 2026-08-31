/**
 * Outbound webhook event taxonomy and the on-the-wire envelope. Every delivery,
 * regardless of type, is one `WebhookEnvelope`; the per-type shape lives in
 * `data`. Consumers subscribe to a set of `type`s and dedupe on the envelope
 * `id`. New event types slot in by extending `WEBHOOK_EVENT_TYPES` and adding a
 * `data` builder at the emit site; unknown types are simply never sent.
 */

export const WEBHOOK_EVENT_TYPES = [
  "item.status_changed",
  "item.created",
  "item.deleted",
  "release.shipped",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * After this many *consecutive* deliveries give up (each having exhausted its
 * own retry budget), the endpoint is auto-disabled (`active = false`) so a
 * permanently-broken endpoint stops generating doomed traffic. A successful
 * delivery, or a manual Resume, resets the streak.
 */
export const WEBHOOK_FAILURE_DISABLE_THRESHOLD = 5;

/** Human labels for the settings UI checkboxes. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "item.status_changed": "Item status changed",
  "item.created": "Item created",
  "item.deleted": "Item deleted",
  "release.shipped": "Release shipped",
};

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return (
    typeof v === "string" &&
    (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v)
  );
}

/** The signed JSON body delivered to an endpoint. */
export type WebhookEnvelope = {
  id: string; // "evt_..." unique per delivery; consumers dedupe on this
  type: WebhookEventType;
  occurredAt: string; // ISO-8601
  workspace: { id: string; slug: string };
  product: { id: string; key: string; name: string } | null;
  data: Record<string, unknown>;
};
