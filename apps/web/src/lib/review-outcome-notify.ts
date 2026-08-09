import {
  and,
  eq,
  featureGithubLinks,
  notifications,
  repositories,
  type Database,
} from "@specboards/db";
import { createGitHubRepoClient, type GithubEntityEvent } from "@specboards/git";

import { getGithubApp } from "@/lib/github-app";

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
export const MERGED = "spec_change_merged";
export const CLOSED = "spec_change_closed";

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
 * Never throws. A failure here must not fail the delivery, because the link
 * state update that came before it is the more important of the two and GitHub
 * would retry the whole thing.
 */
export async function notifyReviewOutcome(
  db: Database,
  evt: GithubEntityEvent,
): Promise<number> {
  try {
    if (evt.kind !== "pull_request") return 0;
    // Nothing to announce while a review is still running.
    if (evt.state !== "merged" && evt.state !== "closed") return 0;

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

    const reason =
      evt.state === "closed" ? await reviewReason(db, evt) : null;

    let raised = 0;
    for (const link of targets) {
      await db.insert(notifications).values({
        workspaceId: link.workspaceId,
        recipientId: link.authorId!,
        // No actor: a merge is an outcome rather than something a particular
        // person did to the author, and naming the person who clicked the
        // button would read as blame on a close.
        actorId: null,
        type: evt.state === "merged" ? MERGED : CLOSED,
        featureId: link.featureId,
        commentId: null,
        snippet: snippetFor(evt.state, evt.title, reason),
      });
      raised += 1;
    }
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
        and(eq(repositories.owner, evt.owner), eq(repositories.name, evt.name)),
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
