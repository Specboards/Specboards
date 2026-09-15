import { type Database } from "@specboards/db";

import type { WorkspaceScope } from "@/lib/store/types";

import { ProposalNotFoundError, ProposalSettledError } from "./errors";
import { handlerFor, type ApplyOutcome, type ApplyOverride } from "./handlers";
import {
  claim,
  getProposal,
  recordResult,
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
 *   3. Claim it. A conditional update is the only atomic operation available,
 *      so it is what actually decides who won when two people click at once.
 *   4. Apply. If this throws, put the claim back: a proposal marked applied
 *      with nothing to show for it is worse than one somebody has to retry.
 *   5. Record what the apply produced, after it has produced it.
 *
 * Step 3 before step 4 is what stops a double-click writing twice. Step 2
 * before step 3 is what stops a refusal needing to be un-claimed.
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

  const claimed = await claim(db, scope, id, "applied");
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

  await recordResult(db, scope, id, outcome);
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
