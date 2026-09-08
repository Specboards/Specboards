import {
  and,
  eq,
  features,
  inArray,
  isNotNull,
  isNull,
  notifications,
  products,
  users,
  workspaces,
  type Database,
} from "@specboards/db";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { renderActionEmail, sendEmail } from "@/lib/email";
import { resolveMailConfig } from "@/lib/mail/config";
import { itemPath } from "@/lib/org-path";
import type { NotificationEventType } from "@/lib/notifications/catalog";
import { unsubscribeToken } from "@/lib/notifications/unsubscribe";

/**
 * The email channel: the same resolved recipient list the in-app fan-out
 * produces, delivered a second way.
 *
 * Immediate only. One message per event somebody has opted into, sent as the
 * event is relayed: no digest, no batching window, no send-time scheduling.
 * That is the release decision, and it is what makes the channel finishable:
 * a digest needs a period and a timezone-correct send time, and those two
 * questions are larger than everything else here put together. The preference
 * model keeps a `frequency` column for them and nothing writes anything but
 * `immediate` to it.
 *
 * ── Where this runs, and why not in the transaction ─────────────────────────
 * Building the messages is database work and happens inside the relay's
 * per-event transaction, where the worker role's grants are. Sending is
 * network work and happens after that transaction commits, which matters for
 * two reasons: an SMTP relay that hangs would otherwise hold a row lock on the
 * outbox for its entire timeout, and a send that fails must not roll back the
 * in-app notification, which is the delivery somebody is actually waiting on.
 *
 * The cost of that split is at-most-once: a process that dies between the
 * commit and the send loses those messages, because the event is already
 * marked processed. That is the right trade for a notification. Re-driving
 * them would mean either sending some twice or making the outbox two-phase,
 * and duplicate mail is a worse failure than absent mail for a channel whose
 * content is also sitting in the recipient's inbox in the app.
 */

/**
 * Anything that can run a read: the relay's transaction, or a plain
 * connection.
 *
 * Structural rather than `Database`, because the two callers hold different
 * things. The relay builds inside its claimed transaction and sends outside
 * it, and a `PgTransaction` is not assignable to `Database` (it has no
 * `$client`) even though every query here works identically on both.
 */
type Reader = Pick<Database, "select">;

/** One resolved notice, as either fan-out path holds it. */
export interface NoticeForEmail {
  /**
   * The in-app row this mirrors, or null when the recipient wants email but
   * not the bell. Used to skip a message whose notification has already been
   * read; a notice with no row has nothing to have been read.
   */
  notificationId: string | null;
  recipientId: string;
  type: NotificationEventType;
  featureId: string;
  snippet: string;
}

/** A message ready to send, plus what the send needs to know about it. */
export interface PendingNotificationEmail {
  notificationId: string | null;
  recipientId: string;
  message: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody: string;
    headers: Record<string, string>;
  };
}

/**
 * Whether this deployment can send at all.
 *
 * Asked before any of the building work rather than at the point of sending,
 * so a deployment with no transport spends one config read per event instead
 * of composing messages for a relay that does not exist. The warning is once
 * per process: `item.assigned` defaults to email on, so an install with no
 * mail would otherwise log a line for every assignment anybody makes.
 */
let warnedNoTransport = false;

async function canSendMail(): Promise<boolean> {
  if (await resolveMailConfig()) return true;
  if (!warnedNoTransport) {
    warnedNoTransport = true;
    console.warn(
      "[notifications] no mail transport is configured, so notification email " +
        "is not being sent. Configure it in Settings, or set EMAIL_FROM with " +
        "either POSTMARK_SERVER_TOKEN or SPECBOARDS_SMTP_HOST. Logged once per " +
        "process.",
    );
  }
  return false;
}

/** Origin for the links in the mail, from env (same source as the auth mail). */
function appOrigin(): string {
  return (
    (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)
      ?.trim()
      .replace(/\/$/, "") ?? ""
  );
}

/**
 * Turn resolved notices into messages, or an empty list if none survive.
 *
 * Everything that can disqualify a recipient is applied here, in one place, so
 * the send step has nothing left to decide:
 *
 *   - no address on the account (nothing to send to),
 *   - the master unsubscribe switch (see `unsubscribe.ts` and migration 0006),
 *   - an item that has since been deleted (nothing to link to).
 *
 * Never throws. Both callers are fan-out paths where a notification is a
 * courtesy on top of a change that has already committed, and neither should
 * lose its in-app rows because a title could not be read.
 */
export async function buildNotificationEmails(
  db: Reader,
  workspaceId: string,
  actorId: string | null,
  notices: readonly NoticeForEmail[],
): Promise<PendingNotificationEmail[]> {
  if (notices.length === 0) return [];
  try {
    if (!(await canSendMail())) return [];
    const origin = appOrigin();
    if (!origin) {
      // Every part of the message is a link: the item, the settings, the
      // unsubscribe. Sending mail with no origin would mean sending dead
      // links, and a dead unsubscribe link is worse than no email at all.
      console.warn(
        "[notifications] APP_URL is not set; skipping notification email.",
      );
      return [];
    }

    const [workspace] = await db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) return [];

    const recipients = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        optedOutAt: users.notificationEmailOptedOutAt,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, [...new Set(notices.map((n) => n.recipientId))]),
          // The master switch, applied at the point of sending rather than by
          // rewriting anybody's preferences. Nothing underneath it can put mail
          // back in the inbox of somebody who has said no.
          isNull(users.notificationEmailOptedOutAt),
        ),
      );
    const byUser = new Map(recipients.map((r) => [r.id, r]));
    if (byUser.size === 0) return [];

    const items = await loadItems(
      db,
      workspaceId,
      notices.map((n) => n.featureId),
    );
    const actor = actorId ? await loadActorName(db, actorId) : null;

    const out: PendingNotificationEmail[] = [];
    for (const notice of notices) {
      const user = byUser.get(notice.recipientId);
      const item = items.get(notice.featureId);
      if (!user || !item) continue;

      const url = `${origin}${itemPath(workspace.slug, item.productKey, item)}`;
      const token = unsubscribeToken(user.id);
      const unsubscribeUrl = token
        ? `${origin}/unsubscribe?t=${encodeURIComponent(token)}`
        : null;
      const settingsUrl = `${origin}/${workspace.slug}/settings/notifications`;

      const { textBody, htmlBody } = renderActionEmail({
        name: user.name,
        intro: introFor(notice, item.title, actor),
        action: "Open in Specboards",
        url,
        links: [
          { label: "Notification settings", url: settingsUrl },
          ...(unsubscribeUrl
            ? [{ label: "Unsubscribe from all notification email", url: unsubscribeUrl }]
            : []),
        ],
      });

      out.push({
        notificationId: notice.notificationId,
        recipientId: user.id,
        message: {
          to: user.email,
          subject: subjectFor(notice, item.title, actor),
          textBody,
          htmlBody,
          // RFC 8058 one-click. The mail client's own unsubscribe button posts
          // to this, with no session and no page load, which is the control
          // most people actually use; the link in the body is for everyone
          // else. Without both headers the large providers treat the message
          // as bulk mail with no way out, which costs the whole deployment its
          // reputation rather than costing us one recipient.
          headers: unsubscribeUrl
            ? {
                "List-Unsubscribe": `<${origin}/api/unsubscribe?t=${encodeURIComponent(
                  token!,
                )}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {},
        },
      });
    }
    return out;
  } catch (err) {
    console.error("[notifications] could not build notification email:", err);
    return [];
  }
}

/**
 * Send what was built, one message at a time, swallowing each failure.
 *
 * Per message rather than per batch: one recipient whose address the relay
 * rejects must not cost the others their mail, and a `Promise.all` would
 * abandon whatever had not been attempted yet.
 *
 * The read check is the one piece of digest-like restraint here. Somebody who
 * has already seen the thing in the app does not need it again in their inbox.
 * The window this catches is small today, because the send follows the commit
 * by milliseconds; it is still worth doing, because it is one query for a
 * whole event and because the window is exactly as wide as the mail queue
 * ahead of it.
 */
export async function sendNotificationEmails(
  db: Reader,
  pending: readonly PendingNotificationEmail[],
): Promise<void> {
  if (pending.length === 0) return;
  try {
    const alreadyRead = await readNotificationIds(
      db,
      pending.map((p) => p.notificationId).filter((id): id is string => !!id),
    );
    for (const p of pending) {
      if (p.notificationId && alreadyRead.has(p.notificationId)) continue;
      try {
        await sendEmail(p.message);
      } catch (err) {
        console.error(
          `[notifications] email to ${p.recipientId} failed:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error("[notifications] email send pass failed:", err);
  }
}

/** Which of these notifications the recipient has already read. */
async function readNotificationIds(
  db: Reader,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(inArray(notifications.id, [...ids]), isNotNull(notifications.readAt)),
    );
  return new Set(rows.map((r) => r.id));
}

interface EmailItem {
  level: string;
  specId: string;
  title: string;
  productKey: string;
}

/**
 * The items these notices point at, with everything a permalink needs.
 *
 * Left-joined to products because a DB-native card can sit outside one, and a
 * missing product is not a reason to withhold somebody's mail: the item path
 * falls back to the all-products segment, which resolves.
 */
async function loadItems(
  db: Reader,
  workspaceId: string,
  featureIds: readonly string[],
): Promise<Map<string, EmailItem>> {
  const unique = [...new Set(featureIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: features.id,
      level: features.level,
      specId: features.specId,
      title: features.title,
      productKey: products.key,
    })
    .from(features)
    .leftJoin(products, eq(products.id, features.productId))
    .where(
      and(eq(features.workspaceId, workspaceId), inArray(features.id, unique)),
    );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        level: r.level,
        specId: r.specId,
        title: r.title,
        productKey: r.productKey ?? ALL_PRODUCTS,
      },
    ]),
  );
}

async function loadActorName(
  db: Reader,
  actorId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * The subject line.
 *
 * Written per type rather than from the snippet, because a subject is read in
 * a list of forty other subjects and has to say which item it is about. The
 * snippet is the right sentence for the body and the wrong one here: for a
 * comment it is the comment itself, which could be anything at all.
 */
function subjectFor(
  notice: NoticeForEmail,
  title: string,
  actor: string | null,
): string {
  const who = actor ?? "Somebody";
  switch (notice.type) {
    case "item.assigned":
      return `${title} was assigned to you`;
    case "item.status_changed":
      // The snippet already names the stage it moved to, and repeating the
      // whole sentence is shorter than reconstructing it from the event.
      return trimSentence(notice.snippet) || `${title} moved`;
    case "item.created":
      return trimSentence(notice.snippet) || `An item was added under ${title}`;
    case "comment.mentioned":
      return `${who} mentioned you on ${title}`;
    case "comment.created":
      return `${who} commented on ${title}`;
    case "spec_change_merged":
      return `Your change to ${title} is live`;
    case "spec_change_closed":
      return `Your change to ${title} was closed`;
    case "release.shipped":
      return trimSentence(notice.snippet) || "A release shipped";
  }
}

/**
 * The sentence above the button.
 *
 * The snippet carries the detail everywhere except a comment, where it is the
 * comment text and needs a sentence in front of it saying who wrote it and
 * where. Quoted rather than run together, so a one-word comment does not read
 * as part of our own copy.
 */
function introFor(
  notice: NoticeForEmail,
  title: string,
  actor: string | null,
): string {
  const who = actor ?? "Somebody";
  if (notice.type === "comment.mentioned") {
    return `${who} mentioned you on ${title}: "${notice.snippet}"`;
  }
  if (notice.type === "comment.created") {
    return `${who} commented on ${title}: "${notice.snippet}"`;
  }
  return notice.snippet;
}

/** A snippet as a subject: one sentence, no trailing full stop. */
function trimSentence(snippet: string): string {
  const first = snippet.split("\n")[0]?.trim() ?? "";
  return first.replace(/\.$/, "");
}
