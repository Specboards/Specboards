import {
  and,
  eq,
  ideaVotes,
  ideas,
  isNotNull,
  portalEmailOptOuts,
} from "@specboards/db";

import type { Database } from "@specboards/db";

import { renderInfoEmail, sendEmail } from "@/lib/email";

import { mintPortalUnsubscribeToken } from "./vote-token";

/**
 * Telling the people outside a workspace what happened to an idea.
 *
 * Two audiences, neither of which has an account: the person who submitted an
 * idea, and everybody who voted for it. This is what the addresses were
 * collected for. Magic-link voting was chosen over a cookie precisely because
 * it yields a contactable list, and a portal that gathers addresses and then
 * goes silent is the worst of both trades.
 *
 * ── Why this is not the in-app notification path ───────────────────────────
 * `notifications/fanout.ts` resolves a `recipientId`, checks workspace
 * membership, checks per-product read access and applies per-user channel
 * preferences, then writes a `notifications` row. Every one of those steps is
 * keyed on a user id these recipients do not have. Sharing the path would mean
 * inventing a fake user for a stranger, which is worse than a second path.
 *
 * So this is a separate consumer of the same outbox event, in the same relay
 * transaction, for the same reason the in-app fan-out is: one claimed event,
 * one `processedAt` stamp, and no way to notify twice.
 */

/** A message ready to send to somebody with no account. */
export interface PendingPortalEmail {
  /** The address, for the log line when a send fails. */
  to: string;
  message: {
    to: string;
    subject: string;
    textBody: string;
    htmlBody: string;
    headers: Record<string, string>;
  };
}

/**
 * Whatever connection the caller already has open, narrowed to what is used.
 *
 * Same shape as `notifications/email.ts`, and split in two because the two
 * The relay reads as `specboards_worker`, which migration 0014 grants SELECT on
 * `ideas`, `idea_votes` (including `voter_email`, the one place that column is
 * readable outside the owner connection) and `portal_email_opt_outs`.
 *
 * The unsubscribe WRITE is not here. It runs on the owner connection, which
 * `portal-auth-isolation.test.ts` forbids anywhere under `lib/portal`, so it
 * lives in `lib/portal-intake/unsubscribe.ts` with the other portal writes.
 */
type Reader = Pick<Database, "select">;

/**
 * What the outbox event carries for an idea state change.
 *
 * Not exported: the relay passes an object literal and `buildPortalEmails`
 * names it in its own signature, so the type is never written down elsewhere.
 */
interface IdeaStateChange {
  ideaId: string;
  title: string;
  /** What to tell the reader, already in public words. See `phraseFor`. */
  phrase: string;
}

/**
 * The people to tell about `ideaId`, minus anybody who has opted out.
 *
 * The submitter and the voters are deliberately merged into one set. A
 * submitter who also voted for their own idea is one person and gets one email,
 * and deduplicating on the lower-cased address is what makes that true whatever
 * case each row happens to store.
 */
export async function portalRecipients(
  db: Reader,
  workspaceId: string,
  ideaId: string,
): Promise<string[]> {
  const [ideaRows, voteRows, optOutRows] = await Promise.all([
    db
      .select({ submitterEmail: ideas.submitterEmail })
      .from(ideas)
      .where(and(eq(ideas.id, ideaId), eq(ideas.workspaceId, workspaceId)))
      .limit(1),
    db
      .select({ voterEmail: ideaVotes.voterEmail })
      .from(ideaVotes)
      .where(
        and(
          eq(ideaVotes.ideaId, ideaId),
          // Scoped to the workspace as well as the idea. An id alone would be
          // enough in practice, since the relay only ever passes an idea's own
          // workspace, but this function returns EMAIL ADDRESSES and the caller
          // being careful is not the same as the query being right. Caught by
          // the cross-workspace case below, which returned voters.
          eq(ideaVotes.workspaceId, workspaceId),
          isNotNull(ideaVotes.voterEmail),
        ),
      ),
    db
      .select({ email: portalEmailOptOuts.email })
      .from(portalEmailOptOuts)
      .where(eq(portalEmailOptOuts.workspaceId, workspaceId)),
  ]);

  const optedOut = new Set(
    optOutRows.map((r: { email: string }) => r.email.trim().toLowerCase()),
  );

  const all = new Set<string>();
  const submitter = ideaRows[0]?.submitterEmail;
  if (submitter) all.add(submitter.trim().toLowerCase());
  for (const v of voteRows as { voterEmail: string | null }[]) {
    if (v.voterEmail) all.add(v.voterEmail.trim().toLowerCase());
  }

  return [...all].filter((e) => e && !optedOut.has(e));
}

/**
 * Build one message per recipient.
 *
 * ── Every message carries its own unsubscribe link ─────────────────────────
 * Not a shared one. The token names the address, so a forwarded email
 * unsubscribes the person it was sent to rather than whoever opened it, and a
 * recipient never needs to type their address into anything to stop the mail.
 *
 * `List-Unsubscribe` as well as the visible link, because mail clients surface
 * the header as a native control and a recipient who uses it is one who did not
 * click "spam" instead.
 */
export function buildPortalEmails(
  workspaceId: string,
  portalTitle: string,
  appOrigin: string,
  orgSlug: string,
  change: IdeaStateChange,
  recipients: readonly string[],
): PendingPortalEmail[] {
  const out: PendingPortalEmail[] = [];
  for (const to of recipients) {
    const token = mintPortalUnsubscribeToken(workspaceId, to);
    // No signing secret means no unsubscribe link, and a message somebody
    // cannot unsubscribe from is one that should not be sent. Silence beats a
    // dead-end.
    if (!token) continue;

    const unsubscribe = `${appOrigin}/${encodeURIComponent(orgSlug)}/ideas/unsubscribe?t=${encodeURIComponent(token)}`;
    const ideaUrl = `${appOrigin}/${encodeURIComponent(orgSlug)}/ideas/${change.ideaId}`;

    const rendered = renderInfoEmail({
      intro: [
        `"${change.title}" ${change.phrase}.`,
        `See it on ${portalTitle}: ${ideaUrl}`,
      ],
      footer: `You are receiving this because you submitted or voted for this idea on ${portalTitle}. Unsubscribe: ${unsubscribe}`,
    });

    out.push({
      to,
      message: {
        to,
        subject: `${change.title} - ${change.phrase}`,
        textBody: rendered.textBody,
        htmlBody: rendered.htmlBody,
        headers: {
          "List-Unsubscribe": `<${unsubscribe}>`,
          // Tells the client the link is safe to hit without a confirmation
          // step, which is what makes the native control one click.
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
    });
  }
  return out;
}

/**
 * Send what was built, outside the relay's transaction.
 *
 * A failure is logged and swallowed per recipient, for the reason the in-app
 * sender gives: the state change has already committed, and one bad address
 * must not cost the other recipients their mail or strand the outbox row.
 */
export async function sendPortalEmails(
  pending: readonly PendingPortalEmail[],
): Promise<void> {
  for (const p of pending) {
    try {
      await sendEmail(p.message);
    } catch (err) {
      console.error(`[portal-notify] email to ${p.to} failed:`, err);
    }
  }
}
