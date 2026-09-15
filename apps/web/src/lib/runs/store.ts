import {
  and,
  agentRuns,
  desc,
  eq,
  inArray,
  modelUsageEvents,
  sql,
  type Database,
} from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import type { WorkspaceScope } from "@/lib/store/types";

import {
  parseTrace,
  type RunStatus,
  type RunTrigger,
  type TraceStep,
} from "./types";

/**
 * Reading and writing run rows.
 *
 * No rules live here. Whether a status change is allowed is the service's
 * question, and whether the caller may see the run at all is the RLS policy's.
 * Everything goes through `asUser` so that policy is what scopes a read,
 * rather than a `where` clause somebody has to remember.
 */

export interface RunRow {
  id: string;
  workspaceId: string;
  productId: string | null;
  targetType: string;
  targetId: string;
  agentId: string | null;
  actorType: string;
  trigger: RunTrigger;
  status: RunStatus;
  summary: string | null;
  error: string | null;
  steer: string | null;
  trace: TraceStep[];
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = {
  id: agentRuns.id,
  workspaceId: agentRuns.workspaceId,
  productId: agentRuns.productId,
  targetType: agentRuns.targetType,
  targetId: agentRuns.targetId,
  agentId: agentRuns.agentId,
  actorType: agentRuns.actorType,
  trigger: agentRuns.trigger,
  status: agentRuns.status,
  summary: agentRuns.summary,
  error: agentRuns.error,
  steer: agentRuns.steer,
  trace: agentRuns.trace,
  startedAt: agentRuns.startedAt,
  finishedAt: agentRuns.finishedAt,
  createdAt: agentRuns.createdAt,
};

/** Narrow the text columns the database has already CHECKed. */
function toRow(r: Record<string, unknown>): RunRow {
  return {
    ...(r as unknown as RunRow),
    trigger: r.trigger as RunTrigger,
    status: r.status as RunStatus,
    trace: parseTrace(r.trace),
  };
}

/** The statuses that mean a run has not finished. */
const ACTIVE: RunStatus[] = ["queued", "running", "awaiting_input"];

interface CreateRunInput {
  workspaceId: string;
  productId: string | null;
  targetType: string;
  targetId: string;
  agentId: string | null;
  actorType: string;
  trigger: RunTrigger;
  status: RunStatus;
  summary: string | null;
  trace: TraceStep[];
}

export async function createRun(
  db: Database,
  scope: WorkspaceScope,
  input: CreateRunInput,
): Promise<RunRow> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .insert(agentRuns)
      .values({ ...input, startedAt: new Date() })
      .returning(COLUMNS),
  );
  if (!row) throw new Error("Run insert returned no row.");
  return toRow(row);
}

export async function getRun(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<RunRow | null> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, id), eq(agentRuns.workspaceId, scope.workspaceId)),
      )
      .limit(1),
  );
  return row ? toRow(row) : null;
}

/**
 * The run this agent already has open on this target, if any.
 *
 * What stops an agent that loses track of its own run id from opening a new
 * one on every call, which would turn a confused agent into an unreadable
 * item card. Scoped to the agent as well as the target: two agents working
 * the same item is a legitimate thing, one agent working it twice is not.
 */
export async function findActiveRun(
  db: Database,
  scope: WorkspaceScope,
  agentId: string | null,
  targetType: string,
  targetId: string,
): Promise<RunRow | null> {
  if (!agentId) return null;
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, scope.workspaceId),
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.targetType, targetType),
          eq(agentRuns.targetId, targetId),
          inArray(agentRuns.status, ACTIVE),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1),
  );
  return row ? toRow(row) : null;
}

interface RunPatch {
  status?: RunStatus;
  summary?: string | null;
  error?: string | null;
  steer?: string | null;
  trace?: TraceStep[];
  finishedAt?: Date | null;
}

export async function patchRun(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  patch: RunPatch,
): Promise<RunRow> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .update(agentRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(eq(agentRuns.id, id), eq(agentRuns.workspaceId, scope.workspaceId)),
      )
      .returning(COLUMNS),
  );
  if (!row) throw new Error("Run update matched no row.");
  return toRow(row);
}

/**
 * Stop a run, if it is still stoppable.
 *
 * Conditional on the run being active, for the reason the proposal claim is
 * conditional: two people pressing Cancel, or a cancel racing the agent's own
 * final report, must resolve to one answer. Returns null when it lost, which
 * the caller reads as "already finished, nothing to stop".
 */
export async function cancelIfActive(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<RunRow | null> {
  const now = new Date();
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .update(agentRuns)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, id),
          eq(agentRuns.workspaceId, scope.workspaceId),
          inArray(agentRuns.status, ACTIVE),
        ),
      )
      .returning(COLUMNS),
  );
  return row ? toRow(row) : null;
}

/** Every run against one target, newest first, for its card. */
export async function listRunsForTarget(
  db: Database,
  scope: WorkspaceScope,
  targetType: string,
  targetId: string,
): Promise<RunRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, scope.workspaceId),
          eq(agentRuns.targetType, targetType),
          eq(agentRuns.targetId, targetId),
        ),
      )
      .orderBy(desc(agentRuns.createdAt)),
  );
  return rows.map(toRow);
}

/** What a run spent, when we were the ones spending it. */
export interface RunTokens {
  prompt: number;
  completion: number;
}

/**
 * Token totals per run, for the runs we actually billed.
 *
 * Summed from `model_usage_events` rather than counted onto the run as it
 * goes, so the number on the card is the same one the spend cap and the usage
 * ledger read. A second tally kept alongside them would eventually disagree
 * with both, and the disagreement would surface as a billing question.
 *
 * A run with no rows is absent from the map, not zero. A connected agent
 * spending its own key produces no usage events, and reporting that as "0
 * tokens" would claim we know it was free.
 */
export async function tokensForRuns(
  db: Database,
  scope: WorkspaceScope,
  runIds: string[],
): Promise<Map<string, RunTokens>> {
  if (runIds.length === 0) return new Map();
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select({
        runId: modelUsageEvents.runId,
        prompt: sql<number>`coalesce(sum(${modelUsageEvents.promptTokens}), 0)::int`,
        completion: sql<number>`coalesce(sum(${modelUsageEvents.completionTokens}), 0)::int`,
      })
      .from(modelUsageEvents)
      .where(
        and(
          eq(modelUsageEvents.workspaceId, scope.workspaceId),
          inArray(modelUsageEvents.runId, runIds),
        ),
      )
      .groupBy(modelUsageEvents.runId),
  );
  const out = new Map<string, RunTokens>();
  for (const r of rows) {
    if (r.runId) out.set(r.runId, { prompt: r.prompt, completion: r.completion });
  }
  return out;
}
