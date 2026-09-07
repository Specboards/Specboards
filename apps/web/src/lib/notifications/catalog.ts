/**
 * The notification event catalog: every kind of thing a user can be told
 * about, and what it says when it lands in their inbox.
 *
 * One catalog, not two. A notification type is either an outbox event type
 * (see `webhooks/types.ts`, which is the same taxonomy seen from the delivery
 * side) or one of the few notices that never pass through the outbox because
 * they originate outside a domain transaction: `spec_change_merged` and
 * `spec_change_closed` are raised by the GitHub webhook sink, which has no
 * domain transaction to hang an event off.
 *
 * A notification type is not always an event type. One `comment.created` event
 * produces two of them: `comment.mentioned` for the people the comment names,
 * `comment.created` for everyone else following the item. They are separate
 * here because they are tuned separately, which is the whole reason a reader
 * can keep mentions while muting the rest.
 *
 * Adding a type here is what makes it appear in the preference matrix, so a
 * new event does not need a UI change to become tunable.
 *
 * ── Why `item.deleted` is not here ──────────────────────────────────────────
 * It is emitted, and webhooks receive it, but it can never reach an inbox:
 * `notifications.feature_id` is NOT NULL with ON DELETE CASCADE, so a row
 * raised for a deleted item either fails to insert or is cascaded away in the
 * same breath. Telling someone their item was deleted needs a notification
 * that can outlive the item, which is a schema change rather than a catalog
 * entry, so it is left out rather than half-built.
 */

/** Where a notification can be delivered. */
export const NOTIFICATION_CHANNELS = ["in_app", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_EVENT_TYPES = [
  "item.assigned",
  "item.status_changed",
  "item.created",
  "comment.mentioned",
  "comment.created",
  "spec_change_merged",
  "spec_change_closed",
  "release.shipped",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * How each channel starts out for a type, before any workspace default or
 * personal override. These are the values the workspace defaults feature seeds
 * a new workspace with, and the values every resolution falls back to while
 * that feature has not landed.
 *
 * Email is deliberately quieter than in-app. Immediate mail is the noisiest
 * setting we have (there is no digest), so it starts on only for the things
 * that are addressed to the reader personally: being given an item, and being
 * named in a comment. Everything else is a thing they can find in the inbox
 * when they look.
 */
export const NOTIFICATION_DEFAULTS: Record<
  NotificationEventType,
  Record<NotificationChannel, boolean>
> = {
  "item.assigned": { in_app: true, email: true },
  "item.status_changed": { in_app: true, email: false },
  // On in-app, off by email. Telling the owner of an epic that a card appeared
  // under it is the rollup that makes a parent worth owning; doing it by mail
  // would put a breakdown session in somebody's inbox one message at a time.
  "item.created": { in_app: true, email: false },
  "comment.mentioned": { in_app: true, email: true },
  "comment.created": { in_app: true, email: false },
  spec_change_merged: { in_app: true, email: true },
  spec_change_closed: { in_app: true, email: true },
  "release.shipped": { in_app: true, email: false },
};
