import {
  and,
  eq,
  featureGithubLinks,
  features,
  isNotNull,
  isNull,
  lt,
  or,
  repositories,
  type Database,
} from "@specboards/db";
import { createGitHubRepoClient } from "@specboards/git";

import { getDb } from "@/lib/db";
import { getGithubApp } from "@/lib/github-app";

/**
 * Correcting a pull request state the webhook never told us about.
 *
 * The webhook is the real mechanism here and this is not a replacement for it:
 * on a healthy installation `state_checked_at` is stamped on every delivery and
 * nothing below ever runs. What this exists for is the case the webhook cannot
 * cover, which is its own absence. A delivery that fails past GitHub's retries,
 * a deploy that was restarting when the event fired, or an installation created
 * before `pull_request` was a subscribed event all leave a link frozen at
 * `open` with nothing in the system that would ever notice.
 *
 * That staleness is not symmetrical, which is why it is worth an API call to
 * fix. A link stuck at `open` tells an author their change is still waiting for
 * review when it merged days ago. They then either wait for a review that has
 * already happened or go asking someone to chase it, which is exactly the
 * confusion this whole authoring flow exists to remove. Being briefly wrong in
 * the other direction costs nothing by comparison.
 */

/**
 * How long a link may go unconfirmed before a view will re-check it. Long
 * enough that a working webhook always gets there first, short enough that a
 * broken one is corrected within a session rather than a day.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Most links to re-check in one view. A cap rather than a queue: an item with
 * twenty stale proposals is not a case worth optimising, and it must not turn a
 * page load into twenty sequential GitHub calls.
 */
const MAX_PER_VIEW = 3;

/**
 * Re-confirm this item's pending spec changes against GitHub when they have
 * gone too long without it. Returns true when a state actually changed, so the
 * caller knows to re-read.
 *
 * Never throws. This runs on the render path of a page whose job is to show a
 * spec; GitHub being slow, rate-limited or down is not a reason for that page
 * to fail, and a stale state is a strictly better outcome than an error.
 */
/** A pending spec change whose state is due to be confirmed again. */
interface StalePendingChange {
  id: string;
  number: number | null;
  state: string | null;
  title: string | null;
  installationId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

/**
 * Which of this item's links are due a re-check, as of `now`.
 *
 * Separated from the fetching so the eligibility rules, which are the part that
 * can quietly be wrong, can be tested against a real database without going
 * near GitHub. Each predicate below excludes something that would otherwise
 * cost an API call and answer a question nobody asked.
 */
export async function selectStalePendingChanges(
  db: Database,
  specId: string,
  workspaceId: string,
  now: Date,
): Promise<StalePendingChange[]> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  return db
    .select({
        id: featureGithubLinks.id,
        number: featureGithubLinks.number,
        state: featureGithubLinks.state,
        title: featureGithubLinks.title,
        installationId: repositories.githubInstallationId,
        owner: repositories.owner,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(featureGithubLinks)
      .innerJoin(features, eq(features.id, featureGithubLinks.featureId))
      .innerJoin(repositories, eq(repositories.id, featureGithubLinks.repoId))
      .where(
        and(
          eq(features.specId, specId),
          eq(featureGithubLinks.workspaceId, workspaceId),
          eq(featureGithubLinks.kind, "pull_request"),
          // Only proposals Specboards opened for a spec edit. A pull request
          // someone pasted onto the card by hand is not something this item
          // claims to report the status of, so polling it would be spending
          // rate limit on a question nobody asked.
          isNotNull(featureGithubLinks.headBranch),
          // A merged or closed review is finished and cannot change again.
          eq(featureGithubLinks.state, "open"),
          or(
            isNull(featureGithubLinks.stateCheckedAt),
            lt(featureGithubLinks.stateCheckedAt, staleBefore),
          ),
        ),
      )
      .limit(MAX_PER_VIEW);
}

/**
 * Re-confirm this item's pending spec changes against GitHub when they have
 * gone too long without it. Returns true when a state actually changed, so the
 * caller knows to re-read.
 *
 * Never throws. This runs on the render path of a page whose job is to show a
 * spec; GitHub being slow, rate-limited or down is not a reason for that page
 * to fail, and a stale state is a strictly better outcome than an error.
 */
export async function reconcilePendingChangeState(
  specId: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    if (!db) return false;

    const stale = await selectStalePendingChanges(db, specId, workspaceId, new Date());
    if (stale.length === 0) return false;

    const app = await getGithubApp(db);
    if (!app) return false;

    let changed = false;
    for (const link of stale) {
      if (link.number === null) continue;
      const client = await createGitHubRepoClient(app, {
        installationId: link.installationId,
        owner: link.owner,
        name: link.name,
        ref: link.defaultBranch,
      });
      const meta = await client.getPullRequest(link.number);
      // Stamped even when nothing moved: the point of the timestamp is "we
      // asked", not "the answer differed". Without that, a genuinely open pull
      // request would be re-fetched on every single view.
      await db
        .update(featureGithubLinks)
        .set({
          state: meta.state,
          title: meta.title,
          stateCheckedAt: new Date(),
        })
        .where(eq(featureGithubLinks.id, link.id));
      if (meta.state !== link.state) changed = true;
    }
    return changed;
  } catch (err) {
    console.error("[pr-state-refresh] reconcile failed:", err);
    return false;
  }
}
