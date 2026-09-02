import {
  GOAL_STATUSES,
  type GoalStatus,
  isGoalStatus,
  isMetricKind,
  METRIC_KINDS,
  type MetricKind,
  validateGoalPeriod,
  validateKeyResult,
} from "@specboards/core";
import { isUuid } from "@/lib/uuid";
import { getStore, type WorkspaceScope } from "@/lib/store";
import type {
  GoalContribution,
  GoalInput,
  GoalPatch,
  GoalRecord,
  ItemGoalRef,
  KeyResultInput,
  KeyResultPatch,
} from "@/lib/store/types";
import { parseDate, parseNotes, parseProductId } from "@/lib/planning-input";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * Goals, their key results, and the items linked to them.
 *
 * Kept together because a key result is not addressable without its goal and
 * the contribution rollup reads both, so splitting them would mean two modules
 * that could never be understood apart.
 */

export async function listGoals(
  scope?: WorkspaceScope,
): Promise<GoalRecord[]> {
  const store = await getStore();
  return store.listGoals(scope);
}

export async function createGoal(
  input: GoalInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.createGoal(input, scope);
}

export async function updateGoal(
  id: string,
  patch: GoalPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.updateGoal(id, patch, scope);
}

export async function deleteGoal(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteGoal(id, scope);
}

export async function createKeyResult(
  goalId: string,
  input: KeyResultInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.createKeyResult(goalId, input, scope);
}

export async function updateKeyResult(
  id: string,
  patch: KeyResultPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.updateKeyResult(id, patch, scope);
}

export async function deleteKeyResult(
  id: string,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  const store = await getStore();
  return store.deleteKeyResult(id, scope);
}

export async function listGoalContributions(
  goalId: string,
  scope?: WorkspaceScope,
): Promise<GoalContribution[]> {
  const store = await getStore();
  return store.listGoalContributions(goalId, scope);
}

export async function listItemGoals(
  specId: string,
  scope?: WorkspaceScope,
): Promise<ItemGoalRef[]> {
  const store = await getStore();
  return store.listItemGoals(specId, scope);
}

export async function linkGoal(
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.linkGoal(goalId, specId, scope);
}

export async function unlinkGoal(
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.unlinkGoal(goalId, specId, scope);
}

/** Parse and validate an untrusted goal POST body. */
export function parseGoalInput(body: unknown): GoalInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const input: GoalInput = { title: raw.title.trim() };
  if ("description" in raw) input.description = parseNotes(raw.description);
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("periodStart" in raw)
    input.periodStart = parseDate(raw.periodStart, "periodStart");
  if ("periodEnd" in raw)
    input.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  if ("parentGoalId" in raw && raw.parentGoalId !== null) {
    if (!isUuid(raw.parentGoalId)) {
      throw new InvalidPatchError("parentGoalId must be a UUID or null.");
    }
    input.parentGoalId = raw.parentGoalId;
  } else if ("parentGoalId" in raw) {
    input.parentGoalId = null;
  }
  if ("status" in raw) input.status = parseGoalStatus(raw.status);
  const periodError = validateGoalPeriod(
    input.periodStart ?? null,
    input.periodEnd ?? null,
  );
  if (periodError) throw new InvalidPatchError(periodError);
  return input;
}

/** Parse and validate an untrusted goal PATCH body. */
export function parseGoalPatch(body: unknown): GoalPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: GoalPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("description" in raw) patch.description = parseNotes(raw.description);
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("periodStart" in raw)
    patch.periodStart = parseDate(raw.periodStart, "periodStart");
  if ("periodEnd" in raw)
    patch.periodEnd = parseDate(raw.periodEnd, "periodEnd");
  if ("parentGoalId" in raw) {
    if (raw.parentGoalId !== null && !isUuid(raw.parentGoalId)) {
      throw new InvalidPatchError("parentGoalId must be a UUID or null.");
    }
    patch.parentGoalId = raw.parentGoalId as string | null;
  }
  if ("status" in raw) patch.status = parseGoalStatus(raw.status);
  // Only checked when both ends are in the patch; a patch moving one end is
  // validated by the store against the stored value it leaves alone.
  if (patch.periodStart !== undefined && patch.periodEnd !== undefined) {
    const periodError = validateGoalPeriod(
      patch.periodStart,
      patch.periodEnd,
    );
    if (periodError) throw new InvalidPatchError(periodError);
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, description, productId, " +
        "periodStart, periodEnd, parentGoalId, status.",
    );
  }
  return patch;
}

/** Parse and validate an untrusted key-result POST body. */
export function parseKeyResultInput(body: unknown): KeyResultInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const metricKind = "metricKind" in raw ? parseMetricKind(raw.metricKind) : undefined;

  // A yes-no key result has no target worth asking for: the target of "did we
  // do it" is always yes. `validateKeyResult` has always exempted boolean from
  // the start-must-differ-from-target rule, but nothing exempted it from
  // needing the number at all, so the exemption was unreachable through the
  // form and picking "boolean" still demanded two numbers to get past.
  //
  // The start value IS meaningful and is kept: a key result can describe
  // something already true when it was written. It is a truth value, so only 0
  // and 1 are accepted; anything else is refused rather than coerced, because
  // silently reading 7 as "yes" is how a typo becomes a measurement.
  const isBoolean = metricKind === "boolean";
  const targetValue = isBoolean
    ? BOOLEAN_TARGET
    : parseFiniteNumber(raw.targetValue, "targetValue");
  if (targetValue === null) {
    throw new InvalidPatchError("targetValue is required.");
  }
  const input: KeyResultInput = { title: raw.title.trim(), targetValue };
  if (metricKind !== undefined) input.metricKind = metricKind;
  const startValue = parseFiniteNumber(raw.startValue, "startValue");
  if (startValue !== null) input.startValue = startValue;
  const currentValue = parseFiniteNumber(raw.currentValue, "currentValue");
  if (currentValue !== null) input.currentValue = currentValue;
  if (isBoolean) {
    assertTruthValue(input.startValue, "startValue");
    assertTruthValue(input.currentValue, "currentValue");
  }
  const error = validateKeyResult({
    metricKind: input.metricKind ?? "number",
    startValue: input.startValue ?? 0,
    targetValue,
  });
  if (error) throw new InvalidPatchError(error);
  return input;
}

/** What "done" is for a yes-no key result; `keyResultProgress` reads any
 * non-zero as done, so this is a stored convention rather than a threshold. */
const BOOLEAN_TARGET = 1;

/**
 * A yes-no key result's values are truth values. Absent is fine (the column
 * defaults handle it); present and outside {0, 1} is a mistake worth naming.
 */
function assertTruthValue(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (value !== 0 && value !== 1) {
    throw new InvalidPatchError(
      `${field} must be 0 or 1 for a yes-no key result.`,
    );
  }
}

/** Parse and validate an untrusted key-result PATCH body. */
export function parseKeyResultPatch(body: unknown): KeyResultPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: KeyResultPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("metricKind" in raw) patch.metricKind = parseMetricKind(raw.metricKind);
  for (const key of ["startValue", "targetValue", "currentValue", "position"] as const) {
    if (!(key in raw)) continue;
    const value = parseFiniteNumber(raw[key], key);
    if (value === null) {
      throw new InvalidPatchError(`${key} must be a number.`);
    }
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, metricKind, startValue, " +
        "targetValue, currentValue, position.",
    );
  }
  return patch;
}

function parseGoalStatus(value: unknown): GoalStatus {
  if (!isGoalStatus(value)) {
    throw new InvalidPatchError(
      `status must be one of: ${GOAL_STATUSES.join(", ")}.`,
    );
  }
  return value;
}

function parseMetricKind(value: unknown): MetricKind {
  if (!isMetricKind(value)) {
    throw new InvalidPatchError(
      `metricKind must be one of: ${METRIC_KINDS.join(", ")}.`,
    );
  }
  return value;
}

/** A finite number, or null when the key is absent/null (not an error). */
function parseFiniteNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidPatchError(`${label} must be a finite number.`);
  }
  return value;
}
