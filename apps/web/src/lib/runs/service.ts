import { and, eq, features, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

import { canEditItem } from "@/lib/assistant-service";

import {
  isTerminal,
  parseError,
  parseSummary,
  RunForbiddenError,
  RunInputError,
  type RunStatus,
  type RunTrigger,
  type TraceStep,
} from "./types";
import {
  cancelIfActive,
  createRun,
  findActiveRun,
  getRun,
  listRunsForTarget,
  patchRun,
  reportUnderLock,
  tokensForRuns,
  type RunRow,
  type RunTokens,
} from "./store";

/**
 * Opening, reporting on, steering and stopping a run.
 *
 * ── What a run is allowed to do ───────────────────────────────────────────
 * Nothing. A run records that an agent is working and what it has done; it is
 * not a permission to change anything. When the agent has something to offer
 * it writes a `proposals` row, and that goes through the handler and the
 * ordinary human write path like every other proposal. Keeping those separate
 * is what stops "the agent may report progress" quietly becoming "the agent
 * may edit the item".
 *
 * ── How cancelling reaches an agent ───────────────────────────────────────
 * It does not, on its own: we have no channel to a connected agent and are
 * not opening one. Cancelling marks the run, and the agent finds out the next
 * time it reports, in the answer it gets back. That makes stopping a run
 * cooperative rather than immediate, which is worth being honest about on the
 * card that offers the button: it stops the run's record and asks the agent
 * to stop, and a badly behaved agent can carry on doing whatever it was doing
 * through the ordinary tool surface.
 */

/** Everything an agent gets told when it reports. */
interface RunReport {
  runId: string;
  status: RunStatus;
  /**
   * A person's note, handed over exactly once and cleared as it goes. The
   * agent is expected to act on it; leaving it set would mean redelivering
   * the same instruction on every call.
   */
  steer: string | null;
  /**
   * Somebody asked this run to stop. The agent should wind up and report
   * nothing further. Set instead of an error, because being cancelled is not
   * the agent doing anything wrong.
   */
  cancelled: boolean;
}

/** The item a run is against, and the product its row records. */
async function resolveItem(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<{ featureId: string; productId: string | null }> {
  const store = await getStore();
  // Through the store, so an item the caller cannot see is indistinguishable
  // from one that does not exist.
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new RunInputError(`Unknown item: ${specId}`);

  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ id: features.id })
      .from(features)
      .where(
        and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  if (!row) throw new RunInputError(`Unknown item: ${specId}`);
  return { featureId: row.id, productId: feature.productId };
}

/**
 * Start work on an item, or pick up the run already open on it.
 *
 * Returning the existing run rather than refusing: an agent that has lost its
 * run id is in an ordinary situation, not an error state, and making it
 * recoverable is cheaper than making it loud. Making it open a second run
 * instead would fill the item card with abandoned ones.
 */
export async function openRun(
  db: Database,
  scope: WorkspaceScope,
  input: {
    specId: string;
    agentId: string | null;
    actorType: string;
    trigger: RunTrigger;
    summary: string | null;
    step: TraceStep | null;
  },
): Promise<RunRow> {
  const { featureId, productId } = await resolveItem(db, scope, input.specId);

  const existing = await findActiveRun(
    db,
    scope,
    input.agentId,
    "feature",
    featureId,
  );
  if (existing) return existing;

  const created = await createRun(db, scope, {
    workspaceId: scope.workspaceId,
    productId,
    targetType: "feature",
    targetId: featureId,
    agentId: input.agentId,
    actorType: input.actorType,
    trigger: input.trigger,
    status: "running",
    summary: input.summary,
    trace: input.step ? [input.step] : [],
  });
  if (created) return created;

  // `agent_runs_one_active_uq` refused it: another request opened the run
  // between our check and our insert. The winner is the answer, which is the
  // same outcome the check above was trying to produce.
  const winner = await findActiveRun(
    db,
    scope,
    input.agentId,
    "feature",
    featureId,
  );
  if (winner) return winner;
  // The conflicting run finished in the meantime, so there is nothing to
  // join and nothing blocking a fresh one. Rare enough to be worth an honest
  // error rather than a retry loop.
  throw new RunInputError(
    "Another run on this item opened and closed while this one was starting. Try again.",
  );
}

/**
 * Record what a run is doing, and hand back anything waiting for it.
 *
 * Every decision here is taken under a row lock in {@link reportUnderLock}:
 * whether the caller owns the run, whether it is still open, what the trace
 * becomes, and whether there is a steering note to deliver. Written as a read
 * and then an unconditional write, which is what this was, each one is a race
 * (AR-01 and AR-02 in the September 2026 adversarial review).
 *
 * `actorId` is the authenticated caller, threaded from the tool or route
 * rather than taken from the run, because the whole point is to compare them.
 */
export async function reportRun(
  db: Database,
  scope: WorkspaceScope,
  runId: string,
  input: {
    actorId: string | null;
    status: RunStatus;
    summary?: unknown;
    error?: unknown;
    step: TraceStep | null;
  },
): Promise<RunReport> {
  const summary = parseSummary(input.summary);
  const error = parseError(input.error);
  if (input.status === "failed" && !error) {
    // A failure nobody can read is a failure nobody can fix. The person
    // looking at the card is the audience, and only the agent knows.
    throw new RunInputError(
      'Reporting "failed" requires "error": say what went wrong, for the person who will read it.',
    );
  }

  const outcome = await reportUnderLock(db, scope, runId, {
    actorId: input.actorId,
    status: input.status,
    summary,
    error,
    step: input.step,
  });

  if (outcome.ok) {
    return {
      runId,
      status: outcome.run.status,
      steer: outcome.steer,
      cancelled: false,
    };
  }

  switch (outcome.reason) {
    case "missing":
      throw new RunInputError(`Unknown run: ${runId}`);
    case "not_yours":
      // Deliberately not "that run belongs to <agent>": the caller has no
      // business knowing whose it is, and the useful instruction is the same
      // either way.
      throw new RunForbiddenError(
        "That run was opened by a different agent. Open your own run on this item.",
      );
    case "settled": {
      // Being cancelled is not the agent doing anything wrong, so it is
      // reported rather than thrown: an error would invite a retry, and the
      // right response is to wind up.
      const run = outcome.run!;
      if (run.status === "cancelled") {
        return { runId, status: "cancelled", steer: null, cancelled: true };
      }
      throw new RunInputError(
        `This run already ${run.status}. Open a new one to report more work.`,
      );
    }
  }
}

/**
 * Refuse somebody who can see a run but may not act on it.
 *
 * Cancelling a run and steering it are changes to how an item's work is
 * being done, so they take the same product-write check a human edit of that
 * item takes. Before this, both were gated on workspace membership alone (the
 * route's `authorizeWrite`, plus a membership-level RLS policy), so a
 * read-only member could stop an agent working on a product they can only
 * read. The item card hid the buttons behind `canEdit`, which made the API
 * look closed while it was open: nobody would find it by using the product.
 *
 * Found while validating the September 2026 adversarial review; it is not one
 * of that report's findings.
 */
async function assertMayControl(
  db: Database,
  scope: WorkspaceScope,
  run: RunRow,
): Promise<void> {
  if (run.targetType !== "feature") {
    throw new RunForbiddenError("Only runs against an item can be controlled here.");
  }
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ specId: features.specId })
      .from(features)
      .where(
        and(
          eq(features.id, run.targetId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  // Unreadable and nonexistent read the same from outside, so this cannot be
  // used to probe for items in products the caller cannot see.
  if (!row) throw new RunInputError(`Unknown run: ${run.id}`);

  const store = await getStore();
  const feature = await store.getFeature(row.specId, scope);
  if (!feature) throw new RunInputError(`Unknown run: ${run.id}`);
  if (!(await canEditItem(scope, feature))) {
    throw new RunForbiddenError(
      "Your role does not permit changing work on this item.",
    );
  }
}

/**
 * Leave a note for a running agent.
 *
 * One slot, overwritten. This is steering, not a conversation: an agent that
 * has not collected the last note does not need a queue building up behind
 * it, and the most recent instruction is the one that should reach it.
 */
export async function steerRun(
  db: Database,
  scope: WorkspaceScope,
  runId: string,
  note: string,
): Promise<RunRow> {
  const run = await getRun(db, scope, runId);
  if (!run) throw new RunInputError(`Unknown run: ${runId}`);
  await assertMayControl(db, scope, run);
  if (isTerminal(run.status)) {
    throw new RunInputError("This run has finished, so there is nobody to tell.");
  }
  return patchRun(db, scope, runId, { steer: note });
}

/**
 * Ask a run to stop.
 *
 * Returns null when there was nothing to stop, which the caller should report
 * as "it had already finished" rather than as a failure: the person got the
 * outcome they wanted.
 */
export async function cancelRun(
  db: Database,
  scope: WorkspaceScope,
  runId: string,
): Promise<RunRow | null> {
  const run = await getRun(db, scope, runId);
  if (!run) throw new RunInputError(`Unknown run: ${runId}`);
  await assertMayControl(db, scope, run);
  // Still conditional on the run being active, so two people pressing Cancel,
  // or a cancel racing the agent's own final report, resolve to one answer.
  return cancelIfActive(db, scope, runId);
}

/** A run as the item card shows it. */
export type RunWithTokens = RunRow & {
  /**
   * What it spent, or null when we did not do the spending. Null and zero are
   * different answers here: a connected agent on its own key produces no
   * usage events, and showing "0" would claim we know it was free.
   */
  tokens: RunTokens | null;
};

/**
 * Every run against one item, newest first, for its card.
 *
 * Takes a `specId` because that is what the rest of the app speaks; the
 * target id on the row is `features.id`, and this is where the two meet.
 */
export async function listRunsForItem(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<RunWithTokens[]> {
  const { featureId } = await resolveItem(db, scope, specId);
  const runs = await listRunsForTarget(db, scope, "feature", featureId);
  // One grouped query for the whole list rather than one per run: an item
  // with a long run history would otherwise be a query per row.
  const tokens = await tokensForRuns(
    db,
    scope,
    runs.map((r) => r.id),
  );
  return runs.map((r) => ({ ...r, tokens: tokens.get(r.id) ?? null }));
}
