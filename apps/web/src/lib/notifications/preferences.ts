import type { Database } from "@specboards/db";

import {
  NOTIFICATION_DEFAULTS,
  type NotificationChannel,
  type NotificationEventType,
} from "@/lib/notifications/catalog";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What a single recipient should receive for one event type. */
type ChannelDecision = Record<NotificationChannel, boolean>;

/**
 * Which channels each recipient wants this event type on.
 *
 * The seam the preference features plug into. Two of them land here: the
 * workspace defaults give the base row, and a user's stored overrides replace
 * individual cells. Until they exist, every recipient resolves to the catalog
 * default, which is what makes the fan-out shippable before the settings
 * surfaces are.
 *
 * Deliberately resolved per event rather than cached across the relay batch.
 * Defaults are live (an admin changing one moves everybody who has not
 * overridden it), so a cache that outlives one event would serve a stale
 * default at exactly the moment someone is watching to see whether their
 * change took effect.
 */
export async function channelsFor(
  _tx: Tx,
  _workspaceId: string,
  userIds: readonly string[],
  type: NotificationEventType,
): Promise<Map<string, ChannelDecision>> {
  const base = NOTIFICATION_DEFAULTS[type];
  return new Map(userIds.map((id) => [id, { ...base }]));
}
