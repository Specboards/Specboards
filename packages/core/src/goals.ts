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
 * How a metric kind is named to a person. The keys are how the value is stored
 * and how the API names it; those are not the words to put in a menu, and a
 * dropdown reading "number / percent / boolean" was asking the reader to know
 * the schema. Lives here beside {@link goalStatusLabel} and {@link formatMetric}
 * so every surface naming a metric kind uses the same word for it.
 */
export function metricKindLabel(kind: MetricKind): string {
  switch (kind) {
    case "number":
      return "Number";
    case "percent":
      return "Percentage";
    case "boolean":
      return "Yes-no";
  }
}

/**
 * What a new key result is measured as unless the author says otherwise.
 *
 * Deliberately NOT the same as the column default. `key_results.metric_kind`
 * defaults to `number`, and so does the API when `metricKind` is absent;
 * changing that would silently reinterpret the payload of every existing API
 * and MCP client that omits the field, which is a breaking change to fix a form
 * default. A suggestion to a human looking at a screen and a contract with a
 * program are allowed to differ, and here they should: most key results are
 * proportions, but a caller that says nothing has told us nothing.
 */
export const DEFAULT_NEW_METRIC_KIND: MetricKind = "percent";

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

/** The fields the goal tree is built and ordered from. */
export interface GoalTreeFields {
  id: string;
  parentGoalId: string | null;
  status: GoalStatus;
  periodEnd: string | null;
  title: string;
}

/** One goal in the tree, with its position in it. */
export interface GoalTreeNode<T> {
  goal: T;
  /** 0 at the top level; +1 per generation. */
  depth: number;
  children: GoalTreeNode<T>[];
  /**
   * True when the goal names a parent that is not in this set, so it is drawn
   * at the top level despite having one. The view says so rather than silently
   * presenting it as a root: the parent usually exists, it is just out of
   * scope (another product's goal), and a reader who cannot see that would
   * misread the ladder.
   */
  orphaned: boolean;
}

/**
 * Arrange goals into the tree `parentGoalId` describes, ordered by
 * `compareGoals` among siblings at every level.
 *
 * A goal whose parent is absent from `goals` becomes a top-level node flagged
 * `orphaned` rather than disappearing: this set is nearly always a scoped
 * subset (one product's goals plus the org-wide ones), so a parent out of view
 * is the normal case, not corruption.
 *
 * Cycle-safe. A corrupt tree (a under b under a, which the write path's
 * `wouldCreateGoalCycle` guard exists to prevent) is broken at the repeat and
 * its members still appear exactly once, because a goal nobody can see is
 * worse than one drawn in the wrong place.
 */
export function buildGoalTree<T extends GoalTreeFields>(
  goals: readonly T[],
): GoalTreeNode<T>[] {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const goal of goals) {
    const parent = goal.parentGoalId ? byId.get(goal.parentGoalId) : undefined;
    if (!parent || parent.id === goal.id) {
      roots.push(goal);
      continue;
    }
    const list = childrenOf.get(parent.id);
    if (list) list.push(goal);
    else childrenOf.set(parent.id, [goal]);
  }

  const seen = new Set<string>();
  const build = (goal: T, depth: number): GoalTreeNode<T> => {
    seen.add(goal.id);
    // Filtering on `seen` is what breaks a cycle: an ancestor cannot reappear
    // as its own descendant.
    const children = (childrenOf.get(goal.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .sort(compareGoals);
    return {
      goal,
      depth,
      orphaned: depth === 0 && goal.parentGoalId !== null,
      children: children.map((child) => build(child, depth + 1)),
    };
  };

  const nodes = roots.slice().sort(compareGoals).map((goal) => build(goal, 0));
  // Anything in a cycle is reachable from no root, so it is still unplaced
  // here. Surface it at the top level rather than dropping it.
  for (const goal of goals.slice().sort(compareGoals)) {
    if (!seen.has(goal.id)) nodes.push(build(goal, 0));
  }
  return nodes;
}

/** One row of a rendered goal tree: the goal, and where it sits. */
export interface GoalTreeRow<T> {
  goal: T;
  depth: number;
  orphaned: boolean;
}

/**
 * Walk a goal tree into the order it is read in, each row carrying its depth.
 *
 * Flat rather than nested so the view can indent by depth without nesting the
 * cards inside one another, which would shrink every generation and make a
 * three-deep goal unreadable.
 */
export function flattenGoalTree<T>(
  nodes: readonly GoalTreeNode<T>[],
): GoalTreeRow<T>[] {
  const rows: GoalTreeRow<T>[] = [];
  const walk = (node: GoalTreeNode<T>): void => {
    rows.push({ goal: node.goal, depth: node.depth, orphaned: node.orphaned });
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return rows;
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
