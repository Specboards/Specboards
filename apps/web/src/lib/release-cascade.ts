/**
 * Which descendants a release change should carry with it.
 *
 * Setting a release on an epic moves that one row. Its children keep whatever
 * they had, which is usually nothing, and the result is an epic in a release
 * whose actual work is scheduled into nothing. Breaking down v1.0.0 produced
 * four epics in the release and seventeen children out of it: the release
 * reported four items when it held twenty-one, and every downstream reader (the
 * roadmap lane, the release notes, "what is left") was working from the wrong
 * set.
 *
 * The decisions this file makes, and why:
 *
 * - **The whole subtree, not direct children.** An epic's features have their
 *   own children, so stopping at one level recreates the same bug one level
 *   down.
 * - **A descendant already in a different release is left alone**, and reported
 *   rather than dropped silently. Overwriting somebody's deliberate choice is
 *   the worst outcome available here; a caller that wants it can move that item
 *   itself.
 * - **A descendant that cannot legally hold the release is left alone too.** A
 *   product release only takes items from its own product, so including one
 *   would half-apply the cascade and fail partway. Better to say so up front.
 * - **Clearing a release cascades to nothing.** That is not a special case: it
 *   falls out of the rule above, since every scheduled child is "in a different
 *   release" from no release at all. Worth knowing, because it means unsetting
 *   a parent's release can never mass-unschedule the work underneath it.
 *
 * Deciding is all this file does. Reading the rows, writing the moves, and
 * asking the user happen elsewhere: this is the part worth testing without a
 * database or a browser, and it is the part that was wrong.
 */

/** The columns the planner needs off an item. A `FeatureRecord` satisfies it. */
export interface CascadeRow {
  specId: string;
  parentSpecId: string | null;
  releaseId: string | null;
  productId: string | null;
}

/** What a release change would do to the items underneath it. */
export interface ReleaseCascadePlan {
  /** Descendants to write, in breadth-first order. */
  move: string[];
  /** Left alone because they are scheduled into some other release. */
  skipped: string[];
  /** Left alone because the release belongs to a product they are not in. */
  ineligible: string[];
  /**
   * How many levels below the root the moves reach, counting the root's own
   * children as one. Zero when nothing moves.
   *
   * Here so a prompt can say "17 items across 2 levels" rather than "move
   * children?": the reader is being asked to approve a write they cannot see,
   * and the depth is the part that tells them how far it goes.
   */
  depth: number;
}

/** A fresh empty plan. Built per call so a caller can never mutate a shared one. */
function noCascade(): ReleaseCascadePlan {
  return { move: [], skipped: [], ineligible: [], depth: 0 };
}

/**
 * Plan the cascade of `releaseId` from `rootSpecId` down through `rows`.
 *
 * `rows` is the set the caller may read, so an item filtered out by product
 * access is simply not in the tree and neither are its own children. That is
 * the same answer the caller would get by walking the hierarchy by hand, which
 * is the point: the plan never counts a row the prompt cannot name.
 *
 * `releaseProductId` is the product the target release belongs to, or null for
 * a portfolio release, which every product may use. It is ignored when
 * `releaseId` is null, since clearing has no product to disagree with.
 */
export function planReleaseCascade(
  rows: readonly CascadeRow[],
  rootSpecId: string,
  releaseId: string | null,
  releaseProductId: string | null,
): ReleaseCascadePlan {
  const childrenOf = new Map<string, CascadeRow[]>();
  for (const row of rows) {
    if (row.parentSpecId === null) continue;
    const siblings = childrenOf.get(row.parentSpecId);
    if (siblings) siblings.push(row);
    else childrenOf.set(row.parentSpecId, [row]);
  }
  if (!childrenOf.has(rootSpecId)) return noCascade();

  const plan = noCascade();
  // `seen` bounds the walk rather than repairing it. Parenting refuses to
  // create a cycle, so reaching one means the rows were written around the API,
  // and the honest response is to stop rather than to plan a write against a
  // shape nothing else in the app can render.
  const seen = new Set<string>([rootSpecId]);
  let level: CascadeRow[] = childrenOf.get(rootSpecId) ?? [];
  let depth = 1;

  while (level.length > 0) {
    const next: CascadeRow[] = [];
    for (const row of level) {
      if (seen.has(row.specId)) continue;
      seen.add(row.specId);
      // A descendant is walked through whatever the decision about it was: an
      // untouched item can still have children that need the release, and an
      // item deliberately left in another release does not seal off the work
      // beneath it.
      next.push(...(childrenOf.get(row.specId) ?? []));

      if (row.releaseId === releaseId) continue; // already where it is going
      // Anything already scheduled somewhere else keeps what it has. Note this
      // does not ask what the target is: when the target is "no release" every
      // scheduled descendant lands here, which is what makes clearing a
      // parent's release incapable of mass-unscheduling the work beneath it.
      if (row.releaseId !== null) {
        plan.skipped.push(row.specId);
        continue;
      }
      if (
        releaseId !== null &&
        releaseProductId !== null &&
        row.productId !== releaseProductId
      ) {
        plan.ineligible.push(row.specId);
        continue;
      }
      plan.move.push(row.specId);
      plan.depth = depth;
    }
    level = next;
    depth += 1;
  }
  return plan;
}
