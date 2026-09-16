/**
 * Outbound webhook event taxonomy and the on-the-wire envelope. Every delivery,
 * regardless of type, is one `WebhookEnvelope`; the per-type shape lives in
 * `data`. Consumers subscribe to a set of `type`s and dedupe on the envelope
 * `id`. New event types slot in by extending `WEBHOOK_EVENT_TYPES` and adding a
 * `data` builder at the emit site; unknown types are simply never sent.
 */

export const WEBHOOK_EVENT_TYPES = [
  "item.status_changed",
  "item.assigned",
  "item.created",
  "item.converted",
  "item.deleted",
  "comment.created",
  "release.shipped",
  // ── Agent-facing events ──────────────────────────────────────────────────
  //
  // The dispatch half of the harness. An agent subscribes to these to be told
  // there is work, rather than polling the board for changes.
  //
  // `item.stage_entered` fires at the same moment as `item.status_changed`
  // and is deliberately not the same event. They have different audiences and
  // so different payloads: `item.status_changed` is the audit fact (this
  // moved from A to B) and is what an integration mirroring the board wants,
  // while `item.stage_entered` is a dispatch (this item is sitting in B, here
  // is who owns it and whether that is an agent) and is what something
  // deciding whether to start work needs. Folding them together would mean
  // either an audit event carrying dispatch fields nothing else reads, or a
  // dispatcher re-reading the item on every status change to find out if it
  // cares. An endpoint subscribes by type, so the cost of the split is one
  // extra outbox row per status change, pruned on the ordinary schedule.
  "item.stage_entered",
  "agent.mentioned",
  "run.requested",
  // The return leg of the same harness. `run.requested` hands work out;
  // `proposal.opened` says a result came back and is waiting for a person.
  // An integration that only ever hears the dispatch half has to poll the
  // review queue to find out whether anything happened.
  "proposal.opened",
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
  "item.assigned": "Item assigned",
  "item.created": "Item created",
  "item.converted": "Item type changed",
  "item.deleted": "Item deleted",
  "comment.created": "Comment posted",
  "release.shipped": "Release shipped",
  "item.stage_entered": "Item entered a stage (for agents)",
  "agent.mentioned": "Agent mentioned in a comment",
  "run.requested": "Work handed to an agent",
  "proposal.opened": "An agent proposed a change",
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
