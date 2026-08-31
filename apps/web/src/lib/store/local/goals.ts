/**
 * Goals and key results, in local file mode.
 *
 * Mirrors db/goals.ts, including the two progress figures that are computed on
 * every read and never stored: the key-result mean measures the outcome, the
 * delivery share measures how much of the linked work has shipped, and they
 * stay separate because a goal whose work is all done but whose numbers have
 * not moved is a real state that averaging would hide.
 *
 * What the db store spends most of its goal code on, filtering contributions to
 * the products the caller can read, has no counterpart here: local mode has one
 * user who can read everything.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type GoalStatus,
  type MetricKind,
  compareGoals,
  deliveryProgress,
  goalProgress,
  isGoalStatus,
  keyResultProgress,
  validateGoalPeriod,
  validateKeyResult,
  wouldCreateGoalCycle,
} from "@specboards/core";

import {
  type GoalContribution,
  GoalError,
  type GoalInput,
  type GoalLinkRef,
  type GoalPatch,
  type GoalRecord,
  type ItemGoalRef,
  type KeyResultInput,
  type KeyResultPatch,
  type WorkspaceScope,
} from "../types";

import { isDone, type LocalStoreContext } from "./context";
import { localPath } from "./paths";

export async function listGoals(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<GoalRecord[]> {
  const [rows, doneMap] = await Promise.all([
    readGoals(ctx),
    doneBySpecId(ctx),
  ]);
  return rows.map((g) => toGoalRecord(g, doneMap)).sort(compareGoals);
}

export async function createGoal(
  ctx: LocalStoreContext,
  input: GoalInput,
  _scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const title = input.title.trim();
  if (!title) throw new GoalError("Goal title is required.");
  const periodError = validateGoalPeriod(
    input.periodStart ?? null,
    input.periodEnd ?? null,
  );
  if (periodError) throw new GoalError(periodError);
  const status = input.status ?? "on_track";
  if (!isGoalStatus(status)) {
    throw new GoalError(`Unknown goal status: ${status}`);
  }
  const rows = await readGoals(ctx);
  if (input.parentGoalId && !rows.some((g) => g.id === input.parentGoalId)) {
    throw new GoalError(`Unknown goal: ${input.parentGoalId}`);
  }
  const goal: LocalGoal = {
    id: randomUUID(),
    title,
    description: input.description ?? null,
    productId: input.productId ?? null,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    parentGoalId: input.parentGoalId ?? null,
    status,
    keyResults: [],
    linkedSpecIds: [],
  };
  await writeGoals(ctx, [...rows, goal]);
  return toGoalRecord(goal, new Map());
}

export async function updateGoal(
  ctx: LocalStoreContext,
  id: string,
  patch: GoalPatch,
  _scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const rows = await readGoals(ctx);
  const goal = rows.find((g) => g.id === id);
  if (!goal) throw new GoalError(`Unknown goal: ${id}`);

  const periodStart =
    patch.periodStart !== undefined
      ? patch.periodStart
      : (goal.periodStart ?? null);
  const periodEnd =
    patch.periodEnd !== undefined ? patch.periodEnd : (goal.periodEnd ?? null);
  const periodError = validateGoalPeriod(periodStart, periodEnd);
  if (periodError) throw new GoalError(periodError);

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new GoalError("Goal title is required.");
    goal.title = title;
  }
  if (patch.description !== undefined) goal.description = patch.description;
  if (patch.productId !== undefined) goal.productId = patch.productId;
  if (patch.periodStart !== undefined) goal.periodStart = patch.periodStart;
  if (patch.periodEnd !== undefined) goal.periodEnd = patch.periodEnd;
  if (patch.status !== undefined) {
    if (!isGoalStatus(patch.status)) {
      throw new GoalError(`Unknown goal status: ${patch.status}`);
    }
    goal.status = patch.status;
  }
  if (patch.parentGoalId !== undefined) {
    if (patch.parentGoalId !== null) {
      if (!rows.some((g) => g.id === patch.parentGoalId)) {
        throw new GoalError(`Unknown goal: ${patch.parentGoalId}`);
      }
      const tree = rows.map((g) => ({
        id: g.id,
        parentGoalId: g.parentGoalId ?? null,
      }));
      if (wouldCreateGoalCycle(tree, id, patch.parentGoalId)) {
        throw new GoalError("A goal cannot be nested under itself.");
      }
    }
    goal.parentGoalId = patch.parentGoalId;
  }
  await writeGoals(ctx, rows);
  return toGoalRecord(goal, await doneBySpecId(ctx));
}

export async function deleteGoal(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readGoals(ctx);
  if (!rows.some((g) => g.id === id)) {
    throw new GoalError(`Unknown goal: ${id}`);
  }
  // Children are orphaned to the root, not deleted with their parent
  // (mirrors the DB's ON DELETE SET NULL on parent_goal_id).
  for (const goal of rows) {
    if (goal.parentGoalId === id) goal.parentGoalId = null;
  }
  await writeGoals(
    ctx,
    rows.filter((g) => g.id !== id),
  );
}

export async function createKeyResult(
  ctx: LocalStoreContext,
  goalId: string,
  input: KeyResultInput,
  _scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const rows = await readGoals(ctx);
  const goal = await goalById(ctx, rows, goalId);
  const title = input.title.trim();
  if (!title) throw new GoalError("Key result title is required.");
  const metricKind = input.metricKind ?? "number";
  const startValue = input.startValue ?? 0;
  const error = validateKeyResult({
    metricKind,
    startValue,
    targetValue: input.targetValue,
  });
  if (error) throw new GoalError(error);
  goal.keyResults = goal.keyResults ?? [];
  goal.keyResults.push({
    id: randomUUID(),
    title,
    metricKind,
    startValue,
    targetValue: input.targetValue,
    currentValue: input.currentValue ?? startValue,
    position: goal.keyResults.length,
  });
  await writeGoals(ctx, rows);
  return toGoalRecord(goal, await doneBySpecId(ctx));
}

export async function updateKeyResult(
  ctx: LocalStoreContext,
  id: string,
  patch: KeyResultPatch,
  _scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const rows = await readGoals(ctx);
  const goal = rows.find((g) => (g.keyResults ?? []).some((k) => k.id === id));
  if (!goal) throw new GoalError(`Unknown key result: ${id}`);
  const kr = goal.keyResults!.find((k) => k.id === id)!;

  const metricKind = patch.metricKind ?? kr.metricKind;
  const startValue = patch.startValue ?? kr.startValue;
  const targetValue = patch.targetValue ?? kr.targetValue;
  const error = validateKeyResult({ metricKind, startValue, targetValue });
  if (error) throw new GoalError(error);

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new GoalError("Key result title is required.");
    kr.title = title;
  }
  if (patch.metricKind !== undefined) kr.metricKind = patch.metricKind;
  if (patch.startValue !== undefined) kr.startValue = patch.startValue;
  if (patch.targetValue !== undefined) kr.targetValue = patch.targetValue;
  if (patch.currentValue !== undefined) kr.currentValue = patch.currentValue;
  if (patch.position !== undefined) kr.position = patch.position;
  await writeGoals(ctx, rows);
  return toGoalRecord(goal, await doneBySpecId(ctx));
}

export async function deleteKeyResult(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const rows = await readGoals(ctx);
  const goal = rows.find((g) => (g.keyResults ?? []).some((k) => k.id === id));
  if (!goal) throw new GoalError(`Unknown key result: ${id}`);
  goal.keyResults = goal.keyResults!.filter((k) => k.id !== id);
  await writeGoals(ctx, rows);
  return toGoalRecord(goal, await doneBySpecId(ctx));
}

export async function listGoalContributions(
  ctx: LocalStoreContext,
  goalId: string,
  _scope?: WorkspaceScope,
): Promise<GoalContribution[]> {
  const [rows, all, doneKey] = await Promise.all([
    readGoals(ctx),
    ctx.loadAll(),
    ctx.doneStatusKey(),
  ]);
  const goal = await goalById(ctx, rows, goalId);
  const linked = new Set(goal.linkedSpecIds ?? []);
  return all
    .filter((f) => linked.has(f.specId))
    .map((f) => ({
      specId: f.specId,
      title: f.title,
      status: f.status,
      level: f.level,
      productId: f.productId,
      done: isDone(f.status, doneKey),
    }));
}

export async function listGoalLinks(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<GoalLinkRef[]> {
  const [rows, all] = await Promise.all([readGoals(ctx), ctx.loadAll()]);
  // Links to items that no longer exist are dropped, matching how the two
  // progress figures already ignore them.
  const known = new Set(all.map((f) => f.specId));
  return rows.flatMap((goal) =>
    (goal.linkedSpecIds ?? [])
      .filter((specId) => known.has(specId))
      .map((specId) => ({ goalId: goal.id, specId })),
  );
}

export async function listItemGoals(
  ctx: LocalStoreContext,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<ItemGoalRef[]> {
  const rows = await readGoals(ctx);
  return rows
    .filter((g) => (g.linkedSpecIds ?? []).includes(specId))
    .map((g) => ({
      goalId: g.id,
      title: g.title,
      status: g.status,
      productId: g.productId ?? null,
    }));
}

export async function linkGoal(
  ctx: LocalStoreContext,
  goalId: string,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readGoals(ctx);
  const goal = await goalById(ctx, rows, goalId);
  const all = await ctx.loadAll();
  if (!all.some((f) => f.specId === specId)) {
    throw new GoalError(`Unknown work item: ${specId}`);
  }
  goal.linkedSpecIds = goal.linkedSpecIds ?? [];
  // Linking twice is a no-op: the caller's intent is already true.
  if (!goal.linkedSpecIds.includes(specId)) goal.linkedSpecIds.push(specId);
  await writeGoals(ctx, rows);
}

export async function unlinkGoal(
  ctx: LocalStoreContext,
  goalId: string,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readGoals(ctx);
  const goal = await goalById(ctx, rows, goalId);
  goal.linkedSpecIds = (goal.linkedSpecIds ?? []).filter((s) => s !== specId);
  await writeGoals(ctx, rows);
}

async function readGoals(ctx: LocalStoreContext): Promise<LocalGoal[]> {
  return ctx.readJsonFile<LocalGoal>(localPath(ctx.root, "goals"));
}

async function writeGoals(
  ctx: LocalStoreContext,
  rows: LocalGoal[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "goals")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "goals"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

/** Build the UI record for one stored goal, computing both progress figures. */
function toGoalRecord(
  goal: LocalGoal,
  doneBySpecId: Map<string, boolean>,
): GoalRecord {
  const measures = (goal.keyResults ?? [])
    .slice()
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  // Links to items that no longer exist are ignored rather than counted as
  // not-done, which would drag delivery progress down for no reason.
  const links = (goal.linkedSpecIds ?? [])
    .filter((specId) => doneBySpecId.has(specId))
    .map((specId) => ({ done: doneBySpecId.get(specId) === true }));
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description ?? null,
    productId: goal.productId ?? null,
    periodStart: goal.periodStart ?? null,
    periodEnd: goal.periodEnd ?? null,
    parentGoalId: goal.parentGoalId ?? null,
    status: goal.status,
    keyResults: measures.map((kr) => ({
      ...kr,
      goalId: goal.id,
      progress: keyResultProgress(kr),
    })),
    progress: goalProgress(measures),
    linkedItemCount: links.length,
    deliveryProgress: deliveryProgress(links),
  };
}

/** Map of specId -> is the item done, over every item in the workspace. */
async function doneBySpecId(
  ctx: LocalStoreContext,
): Promise<Map<string, boolean>> {
  const [all, doneKey] = await Promise.all([
    ctx.loadAll(),
    ctx.doneStatusKey(),
  ]);
  return new Map(all.map((f) => [f.specId, isDone(f.status, doneKey)]));
}

/** Resolve a goal by id from the stored set, or throw. */
async function goalById(
  ctx: LocalStoreContext,
  rows: LocalGoal[],
  id: string,
): Promise<LocalGoal> {
  const goal = rows.find((g) => g.id === id);
  if (!goal) throw new GoalError(`Unknown goal: ${id}`);
  return goal;
}

/** A goal persisted in local file mode, with its key results and links nested
 * (file mode has no joins to do). Progress is still computed on read. */
interface LocalGoal {
  id: string;
  title: string;
  description?: string | null;
  productId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  parentGoalId?: string | null;
  status: GoalStatus;
  keyResults?: LocalKeyResult[];
  /** Stable spec ids of the work items laddering up to this goal. */
  linkedSpecIds?: string[];
}

/** A key result nested under a LocalGoal. */
interface LocalKeyResult {
  id: string;
  title: string;
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
  currentValue: number;
  position: number;
}
