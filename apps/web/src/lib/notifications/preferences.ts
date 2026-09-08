import {
  and,
  eq,
  inArray,
  notificationDefaults,
  notificationPreferences,
  type Database,
} from "@specboards/db";

import type {
  NotificationChannel,
  NotificationEventType,
} from "@/lib/notifications/catalog";
import { resolveChannelsPerUser } from "@/lib/notifications/matrix";

/**
 * Anything that can run a read.
 *
 * Structural rather than `Database`, because the callers hold different
 * things: the relay asks inside its claimed transaction, and the GitHub review
 * sink asks on a plain connection, having no domain transaction to be inside.
 * A `PgTransaction` is not assignable to `Database`, and both run this query
 * identically.
 */
type Reader = Pick<Database, "select">;

/** What a single recipient should receive for one event type. */
type ChannelDecision = Record<NotificationChannel, boolean>;

/**
 * Which channels each recipient wants this event type on.
 *
 * Three layers, folded at read time: the catalog default, the workspace's
 * default if an admin has set one, and the recipient's own override if they
 * have one. Only the overrides are stored, which is what makes an admin
 * changing a default move everybody who has not departed from it. See
 * `matrix.ts` for the fold itself.
 *
 * Two queries per event type rather than one join, because the two tables
 * answer different questions and only one of them is per user. Both are
 * indexed on the way they are asked, and the row counts are bounded by the
 * catalog (at most types x channels defaults for a workspace) rather than by
 * anything that grows with the board.
 *
 * Deliberately resolved per event rather than cached across the relay batch.
 * Defaults are live, so a cache that outlived one event would serve a stale
 * default at exactly the moment somebody is watching to see whether their
 * change took effect.
 *
 * ── If this throws ──────────────────────────────────────────────────────────
 * It is left to. `fanOutNotifications` catches and logs, so a failure here
 * costs one event its notifications and says so in the logs. The alternative,
 * falling back to the catalog defaults when the read fails, would keep
 * notifications flowing while silently ignoring every mute anybody had set:
 * the same outage, invisible, and pointed at the people who had asked for
 * quiet. The realistic cause is a missing grant on a database where
 * `infra/worker-role.sql` has not been re-run, which migration 0002 also
 * covers precisely so that this stays unreachable.
 */
export async function channelsFor(
  tx: Reader,
  workspaceId: string,
  userIds: readonly string[],
  type: NotificationEventType,
): Promise<Map<string, ChannelDecision>> {
  if (userIds.length === 0) return new Map();

  const [defaults, overrides] = await Promise.all([
    tx
      .select({
        eventType: notificationDefaults.eventType,
        channel: notificationDefaults.channel,
        enabled: notificationDefaults.enabled,
      })
      .from(notificationDefaults)
      .where(
        and(
          eq(notificationDefaults.workspaceId, workspaceId),
          eq(notificationDefaults.eventType, type),
        ),
      ),
    tx
      .select({
        userId: notificationPreferences.userId,
        eventType: notificationPreferences.eventType,
        channel: notificationPreferences.channel,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.workspaceId, workspaceId),
          eq(notificationPreferences.eventType, type),
          inArray(notificationPreferences.userId, [...userIds]),
        ),
      ),
  ]);

  return resolveChannelsPerUser(userIds, type, defaults, overrides);
}
