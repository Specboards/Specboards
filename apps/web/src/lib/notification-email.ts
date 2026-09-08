import { eq, users } from "@specboards/db";

import { getDb } from "@/lib/db";

/**
 * The master switch behind the unsubscribe link.
 *
 * One boolean on the person (stored as a timestamp; see migration 0006), not a
 * sweep over their preference rows. Turning it on kills every notification
 * email from this deployment and leaves the per-type grid exactly as they left
 * it, so re-subscribing puts them back where they were rather than at the
 * defaults.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 * The unsubscribe link carries no session: that is the whole point of it, and
 * it is why the token in the URL is the authorization. There is no
 * `app.user_id` for a policy to key on, and `users` carries no RLS anyway, so
 * the tenant connection would offer no protection here that this does not.
 * Every caller resolves the user id first, from a verified token or from a
 * session, and passes it in.
 */

/** Whether this person has turned notification email off. */
export async function isNotificationEmailOff(userId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const [row] = await db
    .select({ at: users.notificationEmailOptedOutAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.at != null;
}

/**
 * Turn notification email off or back on for one person.
 *
 * Idempotent, which matters more than it sounds: a mail client may send the
 * one-click POST more than once, and a second unsubscribe must be a quiet
 * success rather than an error page in somebody's mail app. Returns whether
 * the account exists at all, so a caller can tell "done" from "that token
 * names nobody".
 */
export async function setNotificationEmailOff(
  userId: string,
  off: boolean,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const updated = await db
    .update(users)
    // The timestamp is the state and the record of when it changed. Re-running
    // an unsubscribe moves it, which is the honest answer to "when did they
    // last say no".
    .set({ notificationEmailOptedOutAt: off ? new Date() : null })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return updated.length > 0;
}
