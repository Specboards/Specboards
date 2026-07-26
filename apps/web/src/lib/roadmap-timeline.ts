/**
 * Pure geometry for the Roadmap timeline (Gantt) view: resolving the span an
 * item occupies, building the month axis those spans sit on, and projecting a
 * span onto that axis as percentages.
 *
 * Dates here are `YYYY-MM-DD` strings, the shape every date column and every
 * `date` custom field uses, and are parsed as UTC so a viewer's timezone can
 * never shift a bar by a day.
 *
 * Slice 1 resolves an item's span from its release. Items carry no date
 * columns of their own (`features` has `releaseId` and `customFields` but no
 * start/due/target column), so the selectable date-source model that reads
 * `date`-typed custom properties is a follow-on; this module is shaped to take
 * that source as an input rather than assuming the release.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A closed date range. `end` is inclusive and never earlier than `start`. */
export interface Span {
  start: string;
  end: string;
}

/**
 * Parse a `YYYY-MM-DD` day to UTC epoch ms, or null when absent or malformed.
 * Round-trips the parsed components so an out-of-range date (`2026-13-40`)
 * is rejected rather than silently rolling over into the next month.
 */
export function parseDay(day: string | null | undefined): number | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  const ms = Date.UTC(year, month - 1, date);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

/** The date fields a release contributes to the axis. */
export interface ReleaseDates {
  startDate: string | null;
  targetDate: string | null;
  shippedDate: string | null;
}

/**
 * The span a release occupies.
 *
 * Start prefers the planned start and falls back to whichever end date exists,
 * so a release carrying only a target date renders as a point in time instead
 * of being dropped. End prefers the actual ship date, because once a release
 * has shipped that is where it really ended, whether it beat its target or
 * missed it. Returns null when the release carries no usable date at all.
 */
export function releaseSpan(release: ReleaseDates): Span | null {
  const start =
    release.startDate ?? release.targetDate ?? release.shippedDate ?? null;
  const end =
    release.shippedDate ?? release.targetDate ?? release.startDate ?? null;
  const startMs = parseDay(start);
  const endMs = parseDay(end);
  if (start === null || end === null || startMs === null || endMs === null) {
    return null;
  }
  // A release re-dated after it shipped can end before it starts; clamp rather
  // than drawing a bar that runs backwards.
  return endMs < startMs ? { start, end: start } : { start, end };
}

/** One month column on the axis. */
export interface AxisMonth {
  /** `YYYY-MM`; stable React key. */
  key: string;
  /** Short label, e.g. "Jul 26". */
  label: string;
  /** Share of the axis this month occupies, 0-100. */
  widthPct: number;
}

export interface MonthAxis {
  months: AxisMonth[];
  /** UTC ms at the first instant of the first month. */
  startMs: number;
  /** UTC ms at the first instant *after* the last month (exclusive). */
  endMs: number;
}

/** UTC ms at the first instant of the month containing `ms`. */
function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** UTC ms at the first instant of the month after the one containing `ms`. */
function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Build the month axis covering every span, padded out to whole months so the
 * header columns line up with the grid. `today` is folded in when there is
 * already something to draw, so the today marker is always on-axis; it never
 * conjures an axis on its own (a workspace with no dated releases has no
 * timeline, not a one-month timeline around today).
 *
 * Returns null when there is nothing to draw.
 */
export function buildMonthAxis(
  spans: Span[],
  today?: string | null,
): MonthAxis | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    // Iterative rather than Math.min(...points): a workspace with thousands of
    // items would blow the argument limit on a spread.
    const startMs = parseDay(span.start);
    const endMs = parseDay(span.end);
    if (startMs !== null) {
      if (startMs < min) min = startMs;
      if (startMs > max) max = startMs;
    }
    if (endMs !== null) {
      if (endMs < min) min = endMs;
      if (endMs > max) max = endMs;
    }
  }
  if (min === Number.POSITIVE_INFINITY) return null;

  const todayMs = parseDay(today ?? null);
  if (todayMs !== null) {
    if (todayMs < min) min = todayMs;
    if (todayMs > max) max = todayMs;
  }

  const startMs = monthStart(min);
  const endMs = nextMonthStart(max);
  const total = endMs - startMs;
  if (total <= 0) return null;

  const months: AxisMonth[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = nextMonthStart(cursor);
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    months.push({
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: `${MONTH_LABELS[month]} ${String(year).slice(2)}`,
      widthPct: ((Math.min(next, endMs) - cursor) / total) * 100,
    });
    cursor = next;
  }

  return { months, startMs, endMs };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A span's position on the axis, as percentages of the axis width. */
export interface Placement {
  leftPct: number;
  widthPct: number;
}

/**
 * Project a span onto the axis. The end day is inclusive, so a single-day span
 * still has width: the bar runs to the end of that day rather than to its first
 * instant. Both values are clamped into the axis, so a bar can never overhang
 * the grid it is drawn on.
 */
export function projectSpan(span: Span, axis: MonthAxis): Placement | null {
  const startMs = parseDay(span.start);
  const endMs = parseDay(span.end);
  if (startMs === null || endMs === null) return null;
  const total = axis.endMs - axis.startMs;
  if (total <= 0) return null;
  const left = clamp(((startMs - axis.startMs) / total) * 100, 0, 100);
  const rawWidth = ((endMs + DAY_MS - startMs) / total) * 100;
  return { leftPct: left, widthPct: clamp(rawWidth, 0, 100 - left) };
}

/**
 * Position of a single day on the axis as a percentage, or null when the day
 * falls outside it (so the today marker is simply absent on a purely historical
 * or purely future timeline rather than being pinned to an edge and lying).
 */
export function projectDay(
  day: string | null | undefined,
  axis: MonthAxis,
): number | null {
  const ms = parseDay(day);
  if (ms === null) return null;
  const total = axis.endMs - axis.startMs;
  if (total <= 0) return null;
  if (ms < axis.startMs || ms >= axis.endMs) return null;
  return ((ms - axis.startMs) / total) * 100;
}

/** The item fields the timeline needs. */
export interface TimelineItem {
  specId: string;
  title: string;
  status: string;
  /** Hierarchy level key; part of the item detail route. */
  level: string;
  releaseId: string | null;
  productId: string | null;
}

/** The release fields the timeline needs. */
export interface TimelineRelease extends ReleaseDates {
  id: string;
  name: string;
  status: string;
}

export interface TimelineRow {
  item: TimelineItem;
  span: Span;
  placement: Placement;
}

export interface TimelineGroup {
  release: TimelineRelease;
  span: Span;
  placement: Placement;
  rows: TimelineRow[];
}

export interface TimelineModel {
  axis: MonthAxis;
  groups: TimelineGroup[];
  /**
   * Items with no resolvable dates. Surfaced in a tray rather than dropped, so
   * the view never implies coverage it does not have.
   */
  undated: TimelineItem[];
}

/**
 * Assemble the timeline: one group per dated release, its items beneath it,
 * everything undatable collected in `undated`.
 *
 * A release group is shown when it holds items at the active level, or when it
 * has not shipped yet. That keeps an empty upcoming release visible (nothing
 * scheduled into it is a real signal) without padding the view with shipped
 * history that has nothing at this level.
 *
 * Returns null when no release in scope carries a date, which is the "nothing
 * to plot" case the caller renders an empty state for.
 */
export function buildTimeline(
  items: TimelineItem[],
  releases: TimelineRelease[],
  today?: string | null,
): TimelineModel | null {
  const spans = new Map<string, Span>();
  for (const release of releases) {
    const span = releaseSpan(release);
    if (span) spans.set(release.id, span);
  }

  const byRelease = new Map<string, TimelineItem[]>();
  const undated: TimelineItem[] = [];
  for (const item of items) {
    const span = item.releaseId ? spans.get(item.releaseId) : undefined;
    if (!span || !item.releaseId) {
      undated.push(item);
      continue;
    }
    const bucket = byRelease.get(item.releaseId);
    if (bucket) bucket.push(item);
    else byRelease.set(item.releaseId, [item]);
  }

  const visible = releases.filter((release) => {
    if (!spans.has(release.id)) return false;
    if ((byRelease.get(release.id)?.length ?? 0) > 0) return true;
    return release.status !== "shipped";
  });

  const axis = buildMonthAxis(
    visible.map((r) => spans.get(r.id)).filter((s): s is Span => s != null),
    today,
  );
  if (!axis) return null;

  const groups: TimelineGroup[] = [];
  for (const release of visible) {
    const span = spans.get(release.id);
    if (!span) continue;
    const placement = projectSpan(span, axis);
    if (!placement) continue;
    // Slice 1: an item's span is its release's span, so every row in a group
    // shares the group's placement. Slice 2 resolves per-item date fields here,
    // at which point these diverge.
    const rows: TimelineRow[] = (byRelease.get(release.id) ?? []).map(
      (item) => ({ item, span, placement }),
    );
    groups.push({ release, span, placement, rows });
  }

  return { axis, groups, undated };
}

/** Human-readable span, e.g. "13 Jul to 26 Jul 2026". Used for bar labels. */
export function formatSpan(span: Span): string {
  const start = parseDay(span.start);
  const end = parseDay(span.end);
  if (start === null || end === null) return "";
  const a = new Date(start);
  const b = new Date(end);
  const day = (d: Date) => `${d.getUTCDate()} ${MONTH_LABELS[d.getUTCMonth()]}`;
  if (start === end) return `${day(a)} ${b.getUTCFullYear()}`;
  return `${day(a)} to ${day(b)} ${b.getUTCFullYear()}`;
}
