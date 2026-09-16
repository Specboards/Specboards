import { and, eq, features, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import type { WorkspaceScope } from "@/lib/store/types";

import { ProposalNotFoundError, ProposalSettledError } from "./errors";
import { handlerFor, type ApplyOutcome, type ApplyOverride } from "./handlers";
import {
  claim,
  getProposal,
  settle,
  releaseClaim,
  resolverName,
  type ProposalRow,
} from "./store";
import type { ProposalStatus } from "./types";

/**
 * Deciding about a proposal.
 *
 * The order of operations here is the whole file, and it is inherited from
 * `lib/assistant-proposals.ts` because that order was worked out the hard way:
 *
 *   1. Load it, and refuse if it is already settled. This is for the *message*
 *      a person reads, not for safety.
 *   2. Resolve the target, check the caller may change it, run the guards.
 *      Still no writes, so any refusal here leaves the proposal actionable.
 *   3. Claim it, as `applying`. A conditional update is the only atomic
 *      operation available, so it is what actually decides who won when two
 *      people click at once.
 *   4. Apply. If this throws, put the claim back: a proposal marked applied
 *      with nothing to show for it is worse than one somebody has to retry.
 *   5. Settle it to `applied`, with the result, in one statement.
 *
 * Step 3 before step 4 is what stops a double-click writing twice. Step 2
 * before step 3 is what stops a refusal needing to be un-claimed.
 *
 * ── Why the claim is `applying` and not `applied` ────────────────────────
 * Steps 3 and 5 are separate transactions and always will be: step 4 goes
 * through the ordinary human write path, which opens its own. So there is a
 * window, and the only question is what the row says while it is open. It
 * used to say `applied`, which a crash turned into a permanent lie: a
 * proposal asserting a change that never happened. `applying` is the same
 * window described accurately, and the `catch` below closes it for every
 * failure that is not a killed process. What remains is reconcilable rather
 * than wrong, which is the most this shape of code can honestly offer.
 */

interface ProposalDecision {
  id: string;
  status: ProposalStatus;
  resolvedAt: string;
  outcome: ApplyOutcome;
}

/** The proposal, refusing early if it is not ours to decide. */
async function loadOpen(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<ProposalRow> {
  const row = await getProposal(db, scope, id);
  if (!row) throw new ProposalNotFoundError("That proposal is no longer here.");
  if (row.status !== "open") {
    // Named, because the useful thing to know is who got there first: the
    // second person to click is usually looking at a stale queue.
    const who = await resolverName(db, scope, row.resolvedBy);
    if (row.status === "applying") {
      // Not "already applying this proposal", which reads as a grammatical
      // slip rather than a state. Somebody is mid-apply, or a process died
      // mid-apply; either way the honest answer is that the outcome is not
      // known yet and the target is where to look.
      throw new ProposalSettledError(
        `${who ?? "Someone"} started applying this proposal and it has not ` +
          `finished. Check the target's history before deciding again.`,
      );
    }
    throw new ProposalSettledError(
      `${who ?? "Someone"} already ${row.status} this proposal.`,
    );
  }
  return row;
}

/**
 * Apply a proposal to its target.
 *
 * Nothing in this function writes to the target. The handler does, and only
 * by calling the same function a human edit calls. See the header of
 * `handlers.ts` for why that is not negotiable.
 */
export async function applyProposal(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  override?: ApplyOverride,
): Promise<ProposalDecision> {
  const row = await loadOpen(db, scope, id);
  const handler = handlerFor(row.kind);

  // Before the claim: every refusal in here leaves the proposal open.
  const prepared = await handler.prepare(db, scope, row, override);

  const claimed = await claim(db, scope, id, "applying");
  if (!claimed) {
    throw new ProposalSettledError("Someone already decided about this proposal.");
  }

  let outcome: ApplyOutcome;
  try {
    outcome = await handler.apply(db, scope, row, prepared);
  } catch (err) {
    // Most importantly a conflict: the reviewer has to be able to come back to
    // this once the collision is sorted out.
    await releaseClaim(db, scope, id);
    throw err;
  }

  // The write happened, so the row may now say so, and says what it produced
  // in the same statement.
  const settled = await settle(db, scope, id, outcome);
  if (!settled) {
    // The claim went somewhere else while the write was in flight, which
    // should not happen and is not something to paper over: the target HAS
    // been changed, and a row that no longer records that is exactly the
    // inconsistency this state machine exists to make visible.
    throw new ProposalSettledError(
      "The change was applied, but this proposal was resolved by something " +
        "else while it was being applied. Check the item's history.",
    );
  }
  return {
    id,
    status: "applied",
    resolvedAt: claimed.resolvedAt.toISOString(),
    outcome,
  };
}

/**
 * Turn a proposal down. Nothing is written to the target; the record of the
 * decision is the point.
 *
 * A dismissed proposal is not deleted, and that is deliberate, for the reason
 * `rejectProposal` gives about the conversation: "we considered this and did
 * not take it" is part of how a colleague reconstructs why a definition says
 * what it says. Deleting it would leave a run that appears to have done
 * nothing.
 */
export async function dismissProposal(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<ProposalDecision> {
  await loadOpen(db, scope, id);
  const claimed = await claim(db, scope, id, "dismissed");
  if (!claimed) {
    throw new ProposalSettledError("Someone already decided about this proposal.");
  }
  return {
    id,
    status: "dismissed",
    resolvedAt: claimed.resolvedAt.toISOString(),
    outcome: {},
  };
}

/**
 * The target a URL names, for a caller that addresses a proposal by its id.
 *
 * A feature is named by `specId` in every route, and `proposals.target_id`
 * holds `features.id`. The two meet here rather than at each call site.
 */
type ProposalTargetRef =
  | { kind: "feature"; specId: string }
  | { kind: "release"; id: string };

/** Whether `row` is the proposal the URL claims it is. */
async function targets(
  db: Database,
  scope: WorkspaceScope,
  row: ProposalRow,
  ref: ProposalTargetRef,
): Promise<boolean> {
  if (ref.kind === "release") {
    return row.targetType === "release" && row.targetId === ref.id;
  }
  if (row.targetType !== "feature") return false;
  const [hit] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ id: features.id })
      .from(features)
      .where(
        and(
          eq(features.id, row.targetId),
          eq(features.specId, ref.specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  return Boolean(hit);
}

/**
 * Decide about a proposal addressed by its own id.
 *
 * The review inbox needs this because a run proposal has no conversation
 * turn to name it by, and the assistant panel's endpoints are keyed on the
 * message. What the inbox must NOT get is an apply path of its own: two
 * routes that both write a target would be two sets of guards to keep in
 * agreement, which is the drift the single-lifecycle design exists to avoid.
 * So this is the same `applyProposal` and `dismissProposal` underneath, and
 * it hangs off the same per-target endpoints.
 *
 * ── Why the URL still has to name the target ─────────────────────────────
 * An API key's scope is derived from the first path segment, so accepting an
 * edit to an item costs `features:write`: the same grant as editing it by
 * hand, which is what accepting is. A `/api/v1/proposals/:id` endpoint would
 * have derived `proposals:write` instead, and a key holding both that and
 * `assistant:write` could draft a change and approve its own draft, which is
 * the exact failure this feature exists to prevent. Keeping the proposal
 * under its target's URL keeps the scope honest, and this check is what
 * stops the URL being a fiction: a proposal that does not target what the
 * path names is a 404, not a quietly-accepted mismatch.
 */
export async function decideProposal(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  action: "apply" | "dismiss",
  ref: ProposalTargetRef,
  override?: ApplyOverride,
): Promise<ProposalDecision> {
  const row = await getProposal(db, scope, id);
  // Not found and not yours read the same from outside, as everywhere else
  // here: telling them apart would let a caller probe for proposals against
  // items in products they cannot see.
  if (!row || !(await targets(db, scope, row, ref))) {
    throw new ProposalNotFoundError("That proposal is no longer here.");
  }
  return action === "apply"
    ? applyProposal(db, scope, id, override)
    : dismissProposal(db, scope, id);
}
