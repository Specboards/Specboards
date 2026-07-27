/**
 * The portfolio timeline's model: the single-product timeline laddered across
 * the hierarchy, with dependency edges and progress.
 *
 * Deliberately built on `roadmap-timeline.ts` rather than beside it. The axis,
 * the date-source model, the span resolution, the projection, and the undated
 * rule are all imported: what is new here is the ladder (hierarchy rows with
 * rolled-up parent spans), `blocks` edges, and progress/risk. If this file ever
 * starts reimplementing geometry, the base slicing was wrong.
 */

import {
  DEFAULT_AXIS_SCALE,
  DEFAULT_DATE_SOURCES,
  buildAxis,
  itemProgressPct,
  parseDay,
  projectSpan,
  releaseSpan,
  resolveItemSpan,
  type AxisScale,
  type DateSources,
  type Placement,
  type Span,
  type TimeAxis,
  type TimelineItem,
  type TimelineRelease,
} from "@/lib/roadmap-timeline";

/** The item fields the ladder needs on top of the timeline's. */
export interface LadderItem extends TimelineItem {
  parentSpecId: string | null;
  /** Direct children, from the store's roll-up (all levels, not just rendered). */
  childCount: number;
  childDoneCount: number;
}

/**
 * How many hierarchy levels the ladder renders, counting the active level as
 * one. Three is the card's own shape (an initiative expands to epics, an epic to
 * features) and it bounds the payload: at the initiative level, a workspace with
 * thousands of leaf work items must not ship every one of them to draw ten bars.
 *
 * Note the asymmetry, which is deliberate: spans roll up from *every*
 * descendant, so a parent whose only dated work sits below the rendered depth
 * still gets an honest bar.
 */
export const LADDER_DEPTH = 3;

export interface LadderRow {
  item: LadderItem;
  /** 0 at the active level, 1 for its children, and so on. */
  depth: number;
  span: Span;
  placement: Placement;
  /**
   * True when the item carries no dates of its own and the bar was rolled up
   * from its descendants. Rendered differently, because a derived bar is a
   * summary of other rows rather than a commitment anyone made.
   */
  derived: boolean;
  /** Rendered children, so a row knows whether it has a disclosure. */
  childRowCount: number;
  /** 0-100. See progressPct. */
  progressPct: number;
  /** See atRisk. */
  atRisk: boolean;
}

/** One drawn dependency. */
export interface LadderEdge {
  blockerSpecId: string;
  blockedSpecId: string;
  /**
   * The blocker ends after the blocked item starts, which is the case worth
   * seeing: the plan says the blocked work begins before the thing it waits on
   * is finished.
   */
  late: boolean;
  /** The two ends live in different products. */
  crossProduct: boolean;
}

/** A release drawn as a background band behind the rows. */
export interface LadderBand {
  release: TimelineRelease;
  span: Span;
  placement: Placement;
}

export interface LadderModel {
  axis: TimeAxis;
  /** Pre-order: every row appears after its parent. */
  rows: LadderRow[];
  edges: LadderEdge[];
  bands: LadderBand[];
  /** Rendered items with no resolvable span, own or rolled up. */
  undated: LadderItem[];
}

export interface BuildLadderInput {
  /** Every item in scope, at any level: deeper ones still feed rolled-up spans. */
  items: LadderItem[];
  releases: TimelineRelease[];
  /** The level the ladder starts at; its items are the roots. */
  activeLevel: string;
  /** Level keys, top to leaf, so depth can be read off an item's level. */
  levelOrder: string[];
  /** Workflow statuses in order, for leaf progress. Excludes archived. */
  statusOrder: string[];
  /** `blocks` relations, as spec ids (see FeatureStore.listBlockingEdges). */
  blockingEdges: { blockerSpecId: string; blockedSpecId: string }[];
  today: string;
  sources?: DateSources;
  scale?: AxisScale;
}

/**
 * How far a bar is filled. The rule lives in `itemProgressPct`, shared with the
 * release timeline so the two views cannot fill a bar by different arithmetic.
 */
export function progressPct(
  item: LadderItem,
  statusOrder: string[],
): number {
  return itemProgressPct(item, statusOrder);
}

/**
 * Whether a bar is at risk: its end has passed and the work is not finished.
 * Says nothing about velocity, which is the point; anything cleverer stops being
 * explainable.
 */
export function atRisk(span: Span, progress: number, today: string): boolean {
  const end = parseDay(span.end);
  const now = parseDay(today);
  if (end === null || now === null) return false;
  return end < now && progress < 100;
}

/** The union of two spans, or whichever exists. */
function unionSpan(a: Span | null, b: Span | null): Span | null {
  if (!a) return b;
  if (!b) return a;
  const aStart = parseDay(a.start);
  const bStart = parseDay(b.start);
  const aEnd = parseDay(a.end);
  const bEnd = parseDay(b.end);
  if (aStart === null || bStart === null || aEnd === null || bEnd === null) {
    return a;
  }
  return {
    start: aStart <= bStart ? a.start : b.start,
    end: aEnd >= bEnd ? a.end : b.end,
  };
}

/**
 * Build the laddered model.
 *
 * Returns null when nothing in scope can be placed on an axis, the same
 * "nothing to plot" case the base timeline reports.
 */
export function buildLadder(input: BuildLadderInput): LadderModel | null {
  const {
    items,
    releases,
    activeLevel,
    levelOrder,
    statusOrder,
    blockingEdges,
    today,
    sources = DEFAULT_DATE_SOURCES,
    scale = DEFAULT_AXIS_SCALE,
  } = input;

  const releaseSpans = new Map<string, Span>();
  for (const release of releases) {
    const span = releaseSpan(release);
    if (span) releaseSpans.set(release.id, span);
  }

  const byId = new Map(items.map((i) => [i.specId, i]));
  const children = new Map<string, LadderItem[]>();
  for (const item of items) {
    // A parent outside the readable set is treated as absent, so an item never
    // hangs off a row the viewer cannot see.
    if (!item.parentSpecId || !byId.has(item.parentSpecId)) continue;
    const bucket = children.get(item.parentSpecId);
    if (bucket) bucket.push(item);
    else children.set(item.parentSpecId, [item]);
  }

  /** An item's own span from the selected sources, ignoring its descendants. */
  const ownSpan = new Map<string, Span | null>();
  for (const item of items) {
    const release = item.releaseId
      ? releaseSpans.get(item.releaseId) ?? null
      : null;
    ownSpan.set(item.specId, resolveItemSpan(item, release, sources));
  }

  /**
   * An item's span: its own when it has one, otherwise rolled up from every
   * descendant. Memoized, and cycle-safe (a corrupt parent chain must not hang
   * the page).
   */
  const resolved = new Map<string, Span | null>();
  const visiting = new Set<string>();
  function spanOf(specId: string): Span | null {
    const cached = resolved.get(specId);
    if (cached !== undefined) return cached;
    if (visiting.has(specId)) return null;
    visiting.add(specId);
    let span = ownSpan.get(specId) ?? null;
    if (!span) {
      for (const child of children.get(specId) ?? []) {
        span = unionSpan(span, spanOf(child.specId));
      }
    }
    visiting.delete(specId);
    resolved.set(specId, span);
    return span;
  }

  const rootLevelIndex = levelOrder.indexOf(activeLevel);
  const maxLevelIndex =
    rootLevelIndex < 0
      ? Number.POSITIVE_INFINITY
      : rootLevelIndex + LADDER_DEPTH - 1;

  /** Rows in pre-order, with the spans they will be placed at. */
  const staged: { item: LadderItem; depth: number; span: Span | null }[] = [];
  const undated: LadderItem[] = [];

  function stage(item: LadderItem, depth: number): void {
    const span = spanOf(item.specId);
    if (span) staged.push({ item, depth, span });
    else undated.push(item);
    if (depth + 1 >= LADDER_DEPTH) return;
    const kids = [...(children.get(item.specId) ?? [])].sort(compareItems);
    for (const child of kids) {
      const childIndex = levelOrder.indexOf(child.level);
      if (childIndex >= 0 && childIndex > maxLevelIndex) continue;
      stage(child, depth + 1);
    }
  }

  function compareItems(a: LadderItem, b: LadderItem): number {
    const aStart = parseDay(spanOf(a.specId)?.start ?? null);
    const bStart = parseDay(spanOf(b.specId)?.start ?? null);
    if (aStart !== bStart) {
      if (aStart === null) return 1;
      if (bStart === null) return -1;
      return aStart - bStart;
    }
    return a.title.localeCompare(b.title);
  }

  const roots = items.filter((i) => i.level === activeLevel).sort(compareItems);
  for (const root of roots) stage(root, 0);

  // The axis covers the bars and the release bands, so a bar plotted by a custom
  // date field can sit outside the band it belongs to (the slippage the view
  // exists to show) without being clipped away.
  const bandSpans = releases
    .map((r) => releaseSpans.get(r.id))
    .filter((s): s is Span => s != null);
  const axis = buildAxis(
    [...staged.map((s) => s.span!), ...bandSpans],
    today,
    scale,
  );
  if (!axis) return null;

  const renderedChildren = new Map<string, number>();
  for (const { item } of staged) {
    if (!item.parentSpecId) continue;
    renderedChildren.set(
      item.parentSpecId,
      (renderedChildren.get(item.parentSpecId) ?? 0) + 1,
    );
  }

  const rows: LadderRow[] = [];
  for (const { item, depth, span } of staged) {
    const placement = projectSpan(span!, axis);
    if (!placement) continue;
    const progress = progressPct(item, statusOrder);
    rows.push({
      item,
      depth,
      span: span!,
      placement,
      derived: ownSpan.get(item.specId) == null,
      childRowCount: renderedChildren.get(item.specId) ?? 0,
      progressPct: progress,
      atRisk: atRisk(span!, progress, today),
    });
  }

  const rowBySpec = new Map(rows.map((r) => [r.item.specId, r]));
  const edges: LadderEdge[] = [];
  for (const edge of blockingEdges) {
    const blocker = rowBySpec.get(edge.blockerSpecId);
    const blocked = rowBySpec.get(edge.blockedSpecId);
    // Only edges between two drawn bars: an edge to an undated or out-of-scope
    // item has no second endpoint to reach.
    if (!blocker || !blocked) continue;
    const blockerEnd = parseDay(blocker.span.end);
    const blockedStart = parseDay(blocked.span.start);
    edges.push({
      blockerSpecId: edge.blockerSpecId,
      blockedSpecId: edge.blockedSpecId,
      late:
        blockerEnd !== null && blockedStart !== null && blockerEnd > blockedStart,
      crossProduct:
        blocker.item.productId !== null &&
        blocked.item.productId !== null &&
        blocker.item.productId !== blocked.item.productId,
    });
  }

  const bands: LadderBand[] = [];
  for (const release of releases) {
    const span = releaseSpans.get(release.id);
    if (!span) continue;
    const placement = projectSpan(span, axis);
    if (placement) bands.push({ release, span, placement });
  }

  return { axis, rows, edges, bands, undated };
}

/**
 * The rows visible given a set of collapsed ancestors: a row shows when no
 * ancestor above it is collapsed. Pure so the client component can call it on
 * every toggle without re-deriving the tree.
 */
export function visibleRows(
  rows: LadderRow[],
  collapsed: ReadonlySet<string>,
): LadderRow[] {
  const hidden = new Set<string>();
  const out: LadderRow[] = [];
  for (const row of rows) {
    const parent = row.item.parentSpecId;
    const parentHidden = parent !== null && hidden.has(parent);
    const parentCollapsed = parent !== null && collapsed.has(parent);
    if (parentHidden || parentCollapsed) {
      hidden.add(row.item.specId);
      continue;
    }
    out.push(row);
  }
  return out;
}
