import {
  planReleaseCascade,
  type ReleaseCascadePlan,
} from "@/lib/release-cascade";
import { FeatureNotFoundError } from "@/lib/service-errors";
import { getStore, type WorkspaceScope } from "@/lib/store";

/**
 * Carrying a release change down to the work underneath it.
 *
 * Setting a release on an epic used to move exactly one row, which is how
 * v1.0.0 ended up reporting four items when it held twenty-one. The decision
 * about which descendants should follow is in `@/lib/release-cascade` and is
 * tested without a database; this is the part that reads the rows and writes
 * the moves.
 *
 * It is an explicit opt-in everywhere, never a side effect of setting a
 * release. A caller that says nothing gets exactly today's behaviour, which is
 * what makes this safe to add to an endpoint that agents and integrations
 * already use.
 *
 * Deliberately does not import `features-service`: that module offers the
 * cascade as a patch option, so the dependency runs one way and there is no
 * cycle to break later.
 */

/** A cascade that has been planned but not applied. */
interface ReleaseCascadeOffer {
  plan: ReleaseCascadePlan;
  /** The target release's name, for a prompt that can say where things go. */
  releaseName: string | null;
}

/**
 * What cascading `releaseId` from `specId` would do, without doing it.
 *
 * Backs the prompt. The counts have to come from the server because no client
 * holds the whole subtree, and a prompt that guessed would be asking the user
 * to approve a number that might be wrong.
 */
export async function planItemReleaseCascade(
  specId: string,
  releaseId: string | null,
  scope?: WorkspaceScope,
): Promise<ReleaseCascadeOffer> {
  const store = await getStore();
  const item = await store.getFeature(specId, scope);
  if (!item) throw new FeatureNotFoundError(specId);

  // A release the caller cannot see is not a release they can schedule into,
  // so an unresolvable id plans nothing rather than planning against a product
  // it had to guess.
  const release = releaseId
    ? ((await store.listReleases(scope)).find((r) => r.id === releaseId) ?? null)
    : null;
  if (releaseId !== null && release === null) {
    return { plan: emptyPlan(), releaseName: null };
  }

  const rows = await store.listFeatures(scope);
  return {
    plan: planReleaseCascade(rows, specId, releaseId, release?.productId ?? null),
    releaseName: release?.name ?? null,
  };
}

/**
 * Apply the cascade and return how many items moved.
 *
 * Re-plans rather than trusting a list of ids from the caller: the prompt and
 * the confirmation are two round trips, and in between someone else may have
 * scheduled one of those children deliberately. Re-planning means that choice
 * is respected instead of overwritten by a decision made against a stale board.
 *
 * Each move is its own write, so a failure part-way leaves the items already
 * moved where they are and reports what it managed. That is the honest outcome
 * for a bulk convenience: the parent's own change committed before any of this
 * ran, and nothing here is load-bearing enough to justify unwinding it.
 */
export async function applyItemReleaseCascade(
  specId: string,
  releaseId: string | null,
  scope?: WorkspaceScope,
): Promise<{ moved: number }> {
  const { plan } = await planItemReleaseCascade(specId, releaseId, scope);
  if (plan.move.length === 0) return { moved: 0 };

  const store = await getStore();
  let moved = 0;
  for (const childSpecId of plan.move) {
    // The store still enforces that the release may hold this item, so a row
    // the planner mis-judged is refused rather than written.
    await store.updateFeature(childSpecId, { releaseId }, scope);
    moved += 1;
  }
  return { moved };
}

function emptyPlan(): ReleaseCascadePlan {
  return { move: [], skipped: [], ineligible: [], depth: 0 };
}
