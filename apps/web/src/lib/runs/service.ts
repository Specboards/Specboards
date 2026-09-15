import { and, eq, features, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

import {
  appendStep,
  isTerminal,
  parseError,
  parseSummary,
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
  type RunRow,
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

  return createRun(db, scope, {
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
}

/**
 * Record what a run is doing, and hand back anything waiting for it.
 *
 * The status is applied first and the steering note collected second, so an
 * agent reporting `succeeded` still learns about a note left while it was
 * finishing. It cannot act on it, which is the right outcome: the note is
 * cleared either way and the person can see the run finished.
 */
export async function reportRun(
  db: Database,
  scope: WorkspaceScope,
  runId: string,
  input: {
    status: RunStatus;
    summary?: unknown;
    error?: unknown;
    step: TraceStep | null;
  },
): Promise<RunReport> {
  const run = await getRun(db, scope, runId);
  if (!run) throw new RunInputError(`Unknown run: ${runId}`);

  // A cancelled run accepts nothing further and says so plainly. Reported
  // rather than thrown: the agent did nothing wrong, and an error would
  // invite it to retry.
  if (run.status === "cancelled") {
    return { runId, status: "cancelled", steer: null, cancelled: true };
  }
  if (isTerminal(run.status)) {
    throw new RunInputError(
      `This run already ${run.status}. Open a new one to report more work.`,
    );
  }

  const summary = parseSummary(input.summary);
  const error = parseError(input.error);
  if (input.status === "failed" && !error) {
    // A failure nobody can read is a failure nobody can fix. The person
    // looking at the card is the audience, and only the agent knows.
    throw new RunInputError(
      'Reporting "failed" requires "error": say what went wrong, for the person who will read it.',
    );
  }

  const finished = isTerminal(input.status);
  const updated = await patchRun(db, scope, runId, {
    status: input.status,
    ...(summary === null ? {} : { summary }),
    ...(error === null ? {} : { error }),
    ...(input.step ? { trace: appendStep(run.trace, input.step) } : {}),
    // The CHECK in migration 0016 ties these together, so this cannot drift
    // into a finished run with no finishing time.
    finishedAt: finished ? new Date() : null,
    // Taken as it is handed over, so a note is delivered exactly once.
    steer: null,
  });

  return {
    runId,
    status: updated.status,
    steer: run.steer,
    cancelled: false,
  };
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
  return cancelIfActive(db, scope, runId);
}

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
): Promise<RunRow[]> {
  const { featureId } = await resolveItem(db, scope, specId);
  return listRunsForTarget(db, scope, "feature", featureId);
}
