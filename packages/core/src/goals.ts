/**
 * Goals (objectives) and key results: why a piece of work exists, stated in a
 * form that can be measured.
 *
 * A goal is deliberately not a hierarchy level. A level is a containment
 * structure; a goal is a claim with a target, and the work serving it is
 * many-to-many and crosses products. The two are different shapes and merging
 * them would break one or the other.
 *
 * Progress is computed here, never stored, following the RICE precedent: a
 * persisted percentage is a second copy of the truth that drifts from its
 * inputs the moment one of them changes.
 */

/** How a key result is measured. */
export type MetricKind = "number" | "percent" | "boolean";

export const METRIC_KINDS: readonly MetricKind[] = [
  "number",
  "percent",
  "boolean",
];

export function isMetricKind(value: unknown): value is MetricKind {
  return (
    typeof value === "string" && (METRIC_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The owner's confidence in a goal. Deliberately separate from computed
 * progress: a goal can be 80% of the way to its target and still be off track
 * (the remaining 20% is the hard part, or the period is nearly over), and a
 * goal at 20% early in its period can be perfectly on track. Arithmetic cannot
 * tell you which, so a human says.
 */
export type GoalStatus =
  | "on_track"
  | "at_risk"
  | "off_track"
  | "achieved"
  | "missed";

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "on_track",
  "at_risk",
  "off_track",
  "achieved",
  "missed",
];

export function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    typeof value === "string" && (GOAL_STATUSES as readonly string[]).includes(value)
  );
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "on_track":
      return "On track";
    case "at_risk":
      return "At risk";
    case "off_track":
      return "Off track";
    case "achieved":
      return "Achieved";
    case "missed":
      return "Missed";
  }
}

/** A goal status is terminal once the period has been judged. */
export function isGoalClosed(status: GoalStatus): boolean {
  return status === "achieved" || status === "missed";
}

/** The measurement inputs a key result's progress is derived from. */
export interface KeyResultMeasure {
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
  currentValue: number;
}

/**
 * A key result's progress as a percentage, 0-100, clamped at both ends.
 *
 * Measured against the *distance travelled* (start → target), not against the
 * target alone, so a metric that starts at 40 and targets 60 reads 0% at 40
 * rather than 67%. This also makes decreasing metrics ("reduce churn from 8% to
 * 3%") work with no special case: the direction falls out of the arithmetic.
 *
 * Returns null when the measure is degenerate (start equals target), because
 * there is no distance to be a fraction of and any number would be a lie. The
 * DB rejects that case too, so it should only be reachable from unvalidated
 * input.
 */
export function keyResultProgress(kr: KeyResultMeasure): number | null {
  if (kr.metricKind === "boolean") {
    // A boolean key result is done or it isn't; anything non-zero counts as done.
    return kr.currentValue ? 100 : 0;
  }
  const span = kr.targetValue - kr.startValue;
  if (span === 0) return null;
  const travelled = kr.currentValue - kr.startValue;
  const pct = (travelled / span) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * A goal's progress: the mean of its key results' progress, or null when it has
 * none to average.
 *
 * The mean, not a weighted sum, because key results are not ranked and inventing
 * weights would put a number on a judgement nobody made. A goal with no key
 * results is a valid, useful state (an objective can be written before it is
 * made measurable), and reads as "not measured" rather than 0%.
 */
export function goalProgress(keyResults: KeyResultMeasure[]): number | null {
  const values = keyResults
    .map((kr) => keyResultProgress(kr))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Progress of the *work* linked to a goal: the share of contributing items in a
 * terminal status.
 *
 * Reported alongside the key-result figure, never merged into it and never
 * replacing it. They answer different questions: key results measure the
 * outcome the goal is actually about, delivery measures how much of the work
 * someone believed would achieve it has shipped. Shipping everything and moving
 * no metric is exactly the failure mode OKRs exist to surface, so collapsing
 * the two numbers into one would hide it.
 */
export function deliveryProgress(items: { done: boolean }[]): number | null {
  if (items.length === 0) return null;
  const done = items.filter((i) => i.done).length;
  return Math.round((done / items.length) * 100);
}

/** Format a key result's current/target for display, respecting its kind. */
export function formatMetric(value: number, kind: MetricKind): string {
  if (kind === "boolean") return value ? "Yes" : "No";
  const rounded = Math.round(value * 100) / 100;
  return kind === "percent" ? `${rounded}%` : String(rounded);
}

/** The goals a single product should see: its own plus org-wide ones. */
export function goalsForProduct<T extends { productId: string | null }>(
  goals: T[],
  productId: string | null,
): T[] {
  return goals.filter((g) => g.productId === null || g.productId === productId);
}

/**
 * Order goals for display: open goals before closed ones (achieved/missed
 * recede once judged), then by soonest period end, undated last, then by title.
 */
export function compareGoals(
  a: { status: GoalStatus; periodEnd: string | null; title: string },
  b: { status: GoalStatus; periodEnd: string | null; title: string },
): number {
  const aClosed = isGoalClosed(a.status);
  const bClosed = isGoalClosed(b.status);
  if (aClosed !== bClosed) return aClosed ? 1 : -1;
  if (a.periodEnd !== b.periodEnd) {
    if (a.periodEnd === null) return 1;
    if (b.periodEnd === null) return -1;
    return a.periodEnd < b.periodEnd ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}

/**
 * Validate a goal's period. Either end may be omitted (an open-ended objective
 * is legitimate), but a period that ends before it starts is not.
 */
export function validateGoalPeriod(
  periodStart: string | null,
  periodEnd: string | null,
): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (periodStart !== null && !iso.test(periodStart)) {
    return "periodStart must be a YYYY-MM-DD date.";
  }
  if (periodEnd !== null && !iso.test(periodEnd)) {
    return "periodEnd must be a YYYY-MM-DD date.";
  }
  if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) {
    return "A goal's period cannot end before it starts.";
  }
  return null;
}

/** Validate a key result's measurement inputs. */
export function validateKeyResult(kr: {
  metricKind: MetricKind;
  startValue: number;
  targetValue: number;
}): string | null {
  if (!isMetricKind(kr.metricKind)) {
    return `metricKind must be one of: ${METRIC_KINDS.join(", ")}.`;
  }
  if (!Number.isFinite(kr.startValue) || !Number.isFinite(kr.targetValue)) {
    return "startValue and targetValue must be numbers.";
  }
  if (kr.metricKind === "boolean") return null;
  if (kr.startValue === kr.targetValue) {
    return "A key result's target must differ from its starting value.";
  }
  return null;
}

/**
 * Would linking `childId` under `parentId` create a cycle in the goal tree?
 * Goals nest (a company objective holding product ones), so the same guard the
 * product-group tree needs applies here.
 */
export function wouldCreateGoalCycle(
  goals: { id: string; parentGoalId: string | null }[],
  childId: string,
  parentId: string | null,
): boolean {
  if (parentId === null) return false;
  if (parentId === childId) return true;
  const parentOf = new Map(goals.map((g) => [g.id, g.parentGoalId]));
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === childId) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return false;
}
