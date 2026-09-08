import { randomUUID } from "node:crypto";

import {
  and,
  eq,
  featureGithubLinks,
  inArray,
  notifications,
  repositories,
  type Database,
} from "@specboards/db";
import { createGitHubRepoClient, type GithubEntityEvent } from "@specboards/git";

import { getGithubApp } from "@/lib/github-app";
import {
  buildNotificationEmails,
  sendNotificationEmails,
  type NoticeForEmail,
} from "@/lib/notifications/email";
import { channelsFor } from "@/lib/notifications/preferences";

/**
 * Telling an author what became of the change they proposed.
 *
 * They asked for a review through Specboards and will not go looking for the
 * answer on GitHub: a non-technical author does not watch the repo and will
 * never see its notification. Without this, a spec change simply stops being
 * mentioned, and the author is left to guess.
 *
 * Closed matters at least as much as merged, which is why it is not treated as
 * the quiet case. A change that evaporates leaves someone believing their words
 * are live when the document still says the old thing, and they find out when
 * somebody acts on the wrong version. Being turned down out loud is a better
 * outcome than that, so the reviewer's reason is carried across where there is
 * one.
 */

/** Notification types this raises. */
const MERGED = "spec_change_merged";
const CLOSED = "spec_change_closed";

/** How much of a reviewer's comment is carried into the inbox row. */
const SNIPPET_LIMIT = 280;

export function snippetFor(
  state: string,
  title: string | null,
  reason: string | null,
): string {
  // The payload's title is optional, and the item's own title is already the
  // line above this in the inbox row, so a missing one drops out of the
  // sentence rather than becoming "your change to null".
  const what = title ? `Your change to ${title}` : "Your change";
  if (state === "merged") {
    return `${what} is now live.`;
  }
  const base = `${what} was closed without being merged.`;
  if (!reason) return base;
  const trimmed =
    reason.length > SNIPPET_LIMIT ? `${reason.slice(0, SNIPPET_LIMIT - 1)}…` : reason;
  return `${base} The reviewer said: ${trimmed}`;
}

/**
 * Raise inbox notifications for any spec change this event just resolved.
 *
 * Runs after the link rows have been updated, and reads back only those that
 * ended in a finished state and know whose change they were. Deliberately
 * driven by the link rows rather than the event payload: the same pull request
 * can be linked from several workspaces, and each of their authors is a
 * separate person to tell.
 *
 * ── Why repoIds is required rather than derived ─────────────────────────────
 * A pull request number is only unique within a repository, and this used to
 * match on kind, number and state alone. Anyone can install the App on a repo
 * they own, open and merge pull requests numbered 1, 2, 3 with titles of their
 * choosing, and GitHub will deliver validly signed events: every link row at
 * that number and state, in every workspace, would be notified with the
 * attacker's title text. The returned count leaked too, since GitHub shows the
 * response in the sender's own delivery log, making it an oracle for how many
 * workspaces hold a link at a given number.
 *
 * The repositories the event actually belongs to are resolved by the caller
 * (the same set used to update the link rows), and passed in rather than
 * re-derived here, so the notification and the state update cannot disagree
 * about which repos an event touched. It is a required argument, not an
 * optional filter, because the safe default is not something a future caller
 * should be able to omit. A workspace filter would not work: the event carries
 * no workspace, which is exactly why the repo is the unit of scoping.
 *
 * Never throws. A failure here must not fail the delivery, because the link
 * state update that came before it is the more important of the two and GitHub
 * would retry the whole thing.
 *
 * ── Why this does not go through the notification fan-out ───────────────────
 * Everything else reaches an inbox by way of an `outbox_events` row written in
 * the same transaction as the change. There is no such transaction here: the
 * change happened on GitHub, and this is a webhook delivery reacting to it. So
 * these two types are in the notification catalog (they are things a user can
 * tune) but their rows are raised directly.
 *
 * What that used to cost, and no longer does: this path did not consult
 * notification preferences at all, so a person who had muted a review outcome
 * received it anyway. It asks now, using the same resolution the relay uses,
 * which is also what lets these two types reach the email channel like every
 * other one. Only the recipient resolution is different here, because it is
 * the pull request's author rather than an event's audience.
 */
export async function notifyReviewOutcome(
  db: Database,
  evt: GithubEntityEvent,
  repoIds: string[],
): Promise<number> {
  try {
    if (evt.kind !== "pull_request") return 0;
    // Nothing to announce while a review is still running.
    if (evt.state !== "merged" && evt.state !== "closed") return 0;
    // No connected repository means nothing of ours is involved. Guarded
    // explicitly because an empty `inArray` is not a predicate worth trusting.
    if (repoIds.length === 0) return 0;

    const resolved = await db
      .select({
        id: featureGithubLinks.id,
        workspaceId: featureGithubLinks.workspaceId,
        featureId: featureGithubLinks.featureId,
        authorId: featureGithubLinks.authorId,
        repoId: featureGithubLinks.repoId,
        number: featureGithubLinks.number,
      })
      .from(featureGithubLinks)
      .where(
        and(
          inArray(featureGithubLinks.repoId, repoIds),
          eq(featureGithubLinks.kind, "pull_request"),
          eq(featureGithubLinks.number, evt.number),
          eq(featureGithubLinks.state, evt.state),
        ),
      );

    // Only proposals opened through the app have an author to notify. A pull
    // request somebody hand-linked to a card belongs to whoever opened it on
    // GitHub, who is already being told by GitHub.
    const targets = resolved.filter((l) => l.authorId !== null);
    if (targets.length === 0) return 0;

    // Resolved per workspace, not once for the event. The same pull request
    // can be linked from several tenants, and each has its own installation;
    // reading the reviews with whichever installation happened to come back
    // first would spend one tenant's credentials to serve another's
    // notification, and would break outright when that tenant uninstalls.
    const reasonByWorkspace = new Map<string, string | null>();
    const reasonFor = async (workspaceId: string): Promise<string | null> => {
      if (evt.state !== "closed") return null;
      if (!reasonByWorkspace.has(workspaceId)) {
        reasonByWorkspace.set(workspaceId, await reviewReason(db, evt, workspaceId));
      }
      return reasonByWorkspace.get(workspaceId) ?? null;
    };

    const type = evt.state === "merged" ? MERGED : CLOSED;
    // Grouped per workspace, because that is the unit both preferences and the
    // emailed links are scoped to: the same pull request can be linked from
    // several tenants, and each author's settings are their own.
    const emailsByWorkspace = new Map<string, NoticeForEmail[]>();

    let raised = 0;
    for (const link of targets) {
      const reason = await reasonFor(link.workspaceId);
      const recipientId = link.authorId!;
      const snippet = snippetFor(evt.state, evt.title, reason);
      const channels = (
        await channelsFor(db, link.workspaceId, [recipientId], type)
      ).get(recipientId);
      if (!channels?.in_app && !channels?.email) continue;

      // Minted here so the email can name the row it mirrors, and skip itself
      // if the author has already read the thing in the app.
      const notificationId = channels.in_app ? randomUUID() : null;
      if (notificationId) {
        await db.insert(notifications).values({
          id: notificationId,
          workspaceId: link.workspaceId,
          recipientId,
          // No actor: a merge is an outcome rather than something a particular
          // person did to the author, and naming the person who clicked the
          // button would read as blame on a close.
          actorId: null,
          type,
          featureId: link.featureId,
          commentId: null,
          snippet,
        });
        raised += 1;
      }
      if (channels.email) {
        const list = emailsByWorkspace.get(link.workspaceId) ?? [];
        list.push({
          notificationId,
          recipientId,
          type,
          featureId: link.featureId,
          snippet,
        });
        emailsByWorkspace.set(link.workspaceId, list);
      }
    }

    for (const [workspaceId, notices] of emailsByWorkspace) {
      await sendNotificationEmails(
        db,
        await buildNotificationEmails(db, workspaceId, null, notices),
      );
    }

    // Still the count of inbox rows raised, which is what the webhook
    // responder reports. An email is not an inbox row, and counting it here
    // would make the number mean two things at once.
    return raised;
  } catch (err) {
    console.error("[review-outcome-notify] failed:", err);
    return 0;
  }
}

/**
 * The reviewer's reason for closing, or null. Best effort: a missing reason
 * makes the notification less useful, while a failure here must not cost the
 * author the notification itself.
 */
async function reviewReason(
  db: Database,
  evt: GithubEntityEvent,
  workspaceId: string,
): Promise<string | null> {
  try {
    const app = await getGithubApp(db);
    if (!app) return null;
    const [repo] = await db
      .select({
        installationId: repositories.githubInstallationId,
        owner: repositories.owner,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .where(
        and(
          // Scoped to the tenant whose notification this is: two workspaces can
          // connect the same repo, and each must read it with its own
          // installation rather than borrowing the other's.
          eq(repositories.workspaceId, workspaceId),
          eq(repositories.owner, evt.owner),
          eq(repositories.name, evt.name),
        ),
      )
      .limit(1);
    if (!repo) return null;

    const client = await createGitHubRepoClient(app, {
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
      ref: repo.defaultBranch,
    });
    return await client.getLatestReviewBody(evt.number);
  } catch (err) {
    console.error("[review-outcome-notify] could not read the review:", err);
    return null;
  }
}
