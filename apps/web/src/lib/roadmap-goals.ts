/**
 * The goal reading of the Roadmap timeline: one swimlane per goal, holding the
 * work that ladders up to it, drawn on the same axis as the release and ladder
 * views.
 *
 * This is the third way of grouping the same bars. Releases answer "what ships
 * when", the ladder answers "what sits under what", and goals answer "what is
 * this for" - the axis, the date sources, and the zoom are shared, so switching
 * between them re-groups the rows without moving a single date.
 *
 * Two things make a goal lane different from a release band, and both come
 * straight from what a goal is:
 *
 *  - **A lane is not a partition.** Work laddering up to a goal is
 *    many-to-many, so an item serving two goals is drawn in both lanes. A
 *    release band can assume each item appears once; nothing here can.
 *  - **Level does not filter it.** A goal is served by an initiative and by a
 *    single work item alike, so a lane draws whatever is linked at whatever
 *    level, and each row says which level it is. Filtering to the active level
 *    would silently empty the lanes that matter most.
 */

import {
  buildAxis,
  parseDay,
  projectSpan,
  resolveItemSpan,
  releaseSpan,
  DEFAULT_AXIS_SCALE,
  DEFAULT_DATE_SOURCES,
  type AxisScale,
  type DateSources,
  type Placement,
  type Span,
  type TimeAxis,
  type TimelineItem,
  type TimelineRelease,
  type TimelineRow,
} from "@/lib/roadmap-timeline";

/** The goal fields a swimlane needs. */
export interface TimelineGoal {
  id: string;
  title: string;
  /** GoalStatus; kept as a string so this module needs no status vocabulary. */
  status: string;
  productId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Mean of the goal's key results; null when it has none. */
  progress: number | null;
  /** Share of its linked work that is done; null when nothing is linked. */
  deliveryProgress: number | null;
  /** Readable items linked to it, whether or not they can be placed here. */
  linkedItemCount: number;
}

/**
 * The span a goal occupies: its measurement period.
 *
 * Mirrors `releaseSpan`. Either end alone is enough (an objective with a
 * deadline and no stated start is normal), so a goal carrying one date renders
 * as a point in time rather than being dropped. Returns null only when the goal
 * is open-ended at both ends, which is a legitimate state with no place on a
 * time axis.
 */
export function goalSpan(goal: {
  periodStart: string | null;
  periodEnd: string | null;
}): Span | null {
  const start = goal.periodStart ?? goal.periodEnd;
  const end = goal.periodEnd ?? goal.periodStart;
  if (start === null || end === null) return null;
  const startMs = parseDay(start);
  const endMs = parseDay(end);
  if (startMs === null || endMs === null) return null;
  // The DB rejects a period that ends before it starts, so this only guards
  // unvalidated input; clamp rather than draw a bar running backwards.
  return endMs < startMs ? { start, end: start } : { start, end };
}

/** One swimlane: a goal's period, and the work drawn inside it. */
export interface GoalLane {
  goal: TimelineGoal;
  span: Span;
  placement: Placement;
  rows: TimelineRow[];
  /**
   * Items linked to this goal that could not be placed on the axis. Counted per
   * lane rather than pooled, because "three of this goal's items have no dates"
   * is the actionable form of it.
   */
  undatedCount: number;
}

export interface GoalTimelineModel {
  axis: TimeAxis;
  lanes: GoalLane[];
  /**
   * Goals with no period at either end. They have nothing to draw, so they are
   * listed rather than dropped: an objective nobody has dated is a real gap,
   * and the view would otherwise imply it does not exist.
   */
  undatedGoals: TimelineGoal[];
  /**
   * Items in scope that ladder up to no goal in scope. The point of the view is
   * to show what the work is for, so work that answers nothing is exactly what
   * a reader wants to see.
   */
  unlinked: TimelineItem[];
}

interface GoalTimelineInput {
  goals: TimelineGoal[];
  /** Items in scope at every level, not just the active one (see the header). */
  items: TimelineItem[];
  /** Releases in scope, so an item plotted by its release can resolve a span. */
  releases: TimelineRelease[];
  links: { goalId: string; specId: string }[];
  today?: string | null;
  sources?: DateSources;
  scale?: AxisScale;
}

/**
 * Assemble the goal timeline: one lane per dated goal, its linked work beneath.
 *
 * Returns null when no goal in scope carries a period, which is the "nothing to
 * plot" case the caller renders an empty state for. Note that this is decided
 * by the goals alone: a lane with no placeable work is still drawn, because a
 * goal with nothing under it is the most important thing this view can say.
 */
export function buildGoalTimeline({
  goals,
  items,
  releases,
  links,
  today,
  sources = DEFAULT_DATE_SOURCES,
  scale = DEFAULT_AXIS_SCALE,
}: GoalTimelineInput): GoalTimelineModel | null {
  const releaseSpans = new Map<string, Span>();
  for (const release of releases) {
    const span = releaseSpan(release);
    if (span) releaseSpans.set(release.id, span);
  }

  const itemBySpecId = new Map(items.map((item) => [item.specId, item]));
  const specIdsByGoal = new Map<string, string[]>();
  /** Every item linked to any goal in this set, for the unlinked tray. */
  const linkedSpecIds = new Set<string>();
  const goalIds = new Set(goals.map((g) => g.id));
  for (const link of links) {
    if (!goalIds.has(link.goalId)) continue;
    if (!itemBySpecId.has(link.specId)) continue;
    linkedSpecIds.add(link.specId);
    const list = specIdsByGoal.get(link.goalId);
    if (list) list.push(link.specId);
    else specIdsByGoal.set(link.goalId, [link.specId]);
  }

  /** A goal with its span and its work's spans, before the axis exists. */
  type Pending = {
    goal: TimelineGoal;
    span: Span;
    placed: { item: TimelineItem; span: Span }[];
    undatedCount: number;
  };

  const pending: Pending[] = [];
  const undatedGoals: TimelineGoal[] = [];
  const spans: Span[] = [];
  for (const goal of goals) {
    const span = goalSpan(goal);
    if (!span) {
      undatedGoals.push(goal);
      continue;
    }
    spans.push(span);
    const placed: { item: TimelineItem; span: Span }[] = [];
    let undatedCount = 0;
    // Deduped: a link table can carry the same pair twice only if the unique
    // constraint is gone, but a lane must never draw one item twice.
    for (const specId of new Set(specIdsByGoal.get(goal.id) ?? [])) {
      const item = itemBySpecId.get(specId)!;
      const release = item.releaseId
        ? releaseSpans.get(item.releaseId) ?? null
        : null;
      const itemSpan = resolveItemSpan(item, release, sources);
      if (!itemSpan) {
        undatedCount++;
        continue;
      }
      placed.push({ item, span: itemSpan });
      spans.push(itemSpan);
    }
    pending.push({ goal, span, placed, undatedCount });
  }

  const axis = buildAxis(spans, today, scale);
  if (!axis) return null;

  const lanes: GoalLane[] = [];
  for (const entry of pending) {
    const placement = projectSpan(entry.span, axis);
    if (!placement) continue;
    const rows: TimelineRow[] = [];
    for (const { item, span } of entry.placed) {
      const itemPlacement = projectSpan(span, axis);
      if (itemPlacement) rows.push({ item, span, placement: itemPlacement });
    }
    lanes.push({
      goal: entry.goal,
      span: entry.span,
      placement,
      rows,
      undatedCount: entry.undatedCount,
    });
  }

  return {
    axis,
    lanes,
    undatedGoals,
    unlinked: items.filter((item) => !linkedSpecIds.has(item.specId)),
  };
}
