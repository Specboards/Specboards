/**
 * Pure geometry for the Roadmap timeline (Gantt) view: resolving the span an
 * item occupies, building the axis those spans sit on, and projecting a span
 * onto that axis as percentages.
 *
 * Dates here are `YYYY-MM-DD` strings, the shape every date column and every
 * `date` custom field uses, and are parsed as UTC so a viewer's timezone can
 * never shift a bar by a day.
 *
 * An item's span comes from a selectable source (its release, or a `date`-typed
 * custom property at either end), because items carry no date columns of their
 * own: `features` has `releaseId` and `customFields` but no start/due/target
 * column.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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

/**
 * How wide one axis column is. Weeks read a sprint, months a quarter's worth of
 * releases, quarters an annual plan.
 */
export type AxisScale = "week" | "month" | "quarter";

/** Coarsest to finest is not a total order anyone needs; this is the order the
 * control offers, and the order `coarser` walks. */
export const AXIS_SCALES: readonly AxisScale[] = ["week", "month", "quarter"];

/** The scale a timeline uses when the URL says nothing. */
export const DEFAULT_AXIS_SCALE: AxisScale = "month";

/**
 * The next scale out from `scale`, or null at the coarsest. Used to keep a very
 * long range from being drawn as thousands of week columns.
 */
function coarser(scale: AxisScale): AxisScale | null {
  return scale === "week" ? "month" : scale === "month" ? "quarter" : null;
}

/**
 * Parse an untrusted `?zoom=` value, falling back to the default for anything
 * unrecognised so a hand-edited or stale URL still renders.
 */
export function parseAxisScale(raw: string | string[] | undefined): AxisScale {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return AXIS_SCALES.includes(value as AxisScale)
    ? (value as AxisScale)
    : DEFAULT_AXIS_SCALE;
}

/**
 * Most columns any axis will draw. Past this the header stops being readable and
 * the track stops being scrollable at any useful speed, so `buildAxis` steps out
 * to a coarser scale instead. 120 is a decade of months, or a bit over two years
 * of weeks.
 */
const MAX_COLUMNS = 120;

/** One column on the axis: a week, a month, or a quarter. */
export interface AxisColumn {
  /** Scale-qualified period start; stable React key. */
  key: string;
  /** Short label, e.g. "6 Jul", "Jul 26", "Q3 26". */
  label: string;
  /** Share of the axis this column occupies, 0-100. */
  widthPct: number;
}

export interface TimeAxis {
  /**
   * The scale actually drawn. May be coarser than the one requested when the
   * range is too long (see MAX_COLUMNS), so the UI can say so rather than
   * silently disagreeing with the control.
   */
  scale: AxisScale;
  columns: AxisColumn[];
  /** UTC ms at the first instant of the first column. */
  startMs: number;
  /** UTC ms at the first instant *after* the last column (exclusive). */
  endMs: number;
}

/** UTC ms at the first instant of the month containing `ms`. */
function monthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** UTC ms at the Monday starting the week containing `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  // getUTCDay is Sunday-0; shift so Monday is 0 and weeks read Mon-Sun.
  const offset = (d.getUTCDay() + 6) % 7;
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - offset,
  );
}

/** UTC ms at the first instant of the quarter containing `ms`. */
function quarterStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
}

/** UTC ms at the first instant of the column containing `ms`. */
function columnStart(ms: number, scale: AxisScale): number {
  if (scale === "week") return weekStart(ms);
  if (scale === "quarter") return quarterStart(ms);
  return monthStart(ms);
}

/** UTC ms at the first instant of the column after the one containing `ms`. */
function nextColumnStart(ms: number, scale: AxisScale): number {
  const start = columnStart(ms, scale);
  // Weeks are a fixed length in UTC, so arithmetic is safe; months and quarters
  // are not, so they step through the calendar.
  if (scale === "week") return start + WEEK_MS;
  const d = new Date(start);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + (scale === "quarter" ? 3 : 1),
    1,
  );
}

/** Header label for the column starting at `ms`. */
function columnLabel(ms: number, scale: AxisScale): string {
  const d = new Date(ms);
  const year2 = String(d.getUTCFullYear()).slice(2);
  if (scale === "week") return `${d.getUTCDate()} ${MONTH_LABELS[d.getUTCMonth()]}`;
  if (scale === "quarter") {
    return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${year2}`;
  }
  return `${MONTH_LABELS[d.getUTCMonth()]} ${year2}`;
}

/** Lay out the columns of one scale over a resolved domain. */
function layOutColumns(
  min: number,
  max: number,
  scale: AxisScale,
): TimeAxis | null {
  const startMs = columnStart(min, scale);
  const endMs = nextColumnStart(max, scale);
  const total = endMs - startMs;
  if (total <= 0) return null;

  const columns: AxisColumn[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = nextColumnStart(cursor, scale);
    columns.push({
      key: `${scale}:${new Date(cursor).toISOString().slice(0, 10)}`,
      label: columnLabel(cursor, scale),
      widthPct: ((Math.min(next, endMs) - cursor) / total) * 100,
    });
    cursor = next;
  }

  return { scale, columns, startMs, endMs };
}

/**
 * Build the axis covering every span, padded out to whole periods so the header
 * columns line up with the grid. `today` is folded in when there is already
 * something to draw, so the today marker is always on-axis; it never conjures an
 * axis on its own (a workspace with no dated releases has no timeline, not a
 * one-month timeline around today).
 *
 * A range too long for the requested scale is drawn one scale coarser rather
 * than as an unreadable header, and the axis reports which scale it landed on.
 *
 * Returns null when there is nothing to draw.
 */
export function buildAxis(
  spans: Span[],
  today?: string | null,
  scale: AxisScale = DEFAULT_AXIS_SCALE,
): TimeAxis | null {
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

  let active: AxisScale | null = scale;
  while (active) {
    const axis = layOutColumns(min, max, active);
    if (!axis) return null;
    if (axis.columns.length <= MAX_COLUMNS) return axis;
    const next = coarser(active);
    // At the coarsest scale a long range is simply long: draw it rather than
    // refusing, since a 30-year quarter axis is still legible.
    if (!next) return axis;
    active = next;
  }
  return null;
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
export function projectSpan(span: Span, axis: TimeAxis): Placement | null {
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
  axis: TimeAxis,
): number | null {
  const ms = parseDay(day);
  if (ms === null) return null;
  const total = axis.endMs - axis.startMs;
  if (total <= 0) return null;
  if (ms < axis.startMs || ms >= axis.endMs) return null;
  return ((ms - axis.startMs) / total) * 100;
}

/**
 * Where the timeline reads a bar's start (or end) from.
 *
 * `release` uses the span of the release the item is scheduled into, which is
 * the only source that needs no workspace setup. A `property` source reads a
 * `date`-typed custom property off the item, so a workspace with a "Due date"
 * field can plan by it. Start and end are chosen independently, so "release
 * start to due date" is expressible and shows slippage directly.
 */
export type DateSource =
  | { kind: "release" }
  | { kind: "property"; key: string };

/** The reserved `?start=` / `?end=` value meaning "use the release span". */
export const RELEASE_SOURCE = "release";
/** Prefix marking a custom-property source, so a property keyed `release`
 * cannot collide with the reserved value above. */
const PROPERTY_PREFIX = "cf:";

/** Serialize a source for the URL. */
export function dateSourceParam(source: DateSource): string {
  return source.kind === "release"
    ? RELEASE_SOURCE
    : `${PROPERTY_PREFIX}${source.key}`;
}

/**
 * Parse an untrusted `?start=` / `?end=` value. Falls back to the release span
 * for anything unrecognised, including a property that no longer exists, so a
 * stale bookmark degrades to the default view rather than an empty one.
 */
export function parseDateSource(
  raw: string | string[] | undefined,
  availableKeys: readonly string[],
): DateSource {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith(PROPERTY_PREFIX)) return { kind: "release" };
  const key = value.slice(PROPERTY_PREFIX.length);
  return availableKeys.includes(key)
    ? { kind: "property", key }
    : { kind: "release" };
}

/** The start and end sources a timeline is currently plotted by. */
export interface DateSources {
  start: DateSource;
  end: DateSource;
}

/** The default: both ends read from the release, matching the board. */
export const DEFAULT_DATE_SOURCES: DateSources = {
  start: { kind: "release" },
  end: { kind: "release" },
};

/** The item fields the timeline needs. */
export interface TimelineItem {
  specId: string;
  title: string;
  status: string;
  /** Hierarchy level key; part of the item detail route. */
  level: string;
  releaseId: string | null;
  productId: string | null;
  /**
   * Custom-property values, keyed by property key. Only `date`-typed entries
   * are read here, and only when a property source is selected; values are
   * `YYYY-MM-DD` strings (enforced on write by assertCustomFieldTypes).
   */
  customFields: Record<string, unknown>;
  /**
   * Direct children and how many of them are done, from the store's roll-up.
   * Optional because the base timeline can draw a bar without them; supplied,
   * they let a parent's progress read its children instead of its own status.
   */
  childCount?: number;
  childDoneCount?: number;
}

/**
 * How far one item has got, 0-100.
 *
 * A parent reads its children (`childDoneCount / childCount`, over all direct
 * children, not just the ones drawn). A leaf reads how far its status has moved
 * through the workflow. One rule, statable in a sentence, which matters more
 * here than precision: a score nobody can interpret is worse than no fill.
 *
 * Lives here rather than in the ladder because both timelines fill bars by it
 * and the ladder is built on this module, not beside it.
 */
export function itemProgressPct(
  item: Pick<TimelineItem, "status" | "childCount" | "childDoneCount">,
  statusOrder: readonly string[],
): number {
  if (item.childCount && item.childCount > 0) {
    return Math.round(((item.childDoneCount ?? 0) / item.childCount) * 100);
  }
  const index = statusOrder.indexOf(item.status);
  if (index < 0 || statusOrder.length < 2) return 0;
  return Math.round((index / (statusOrder.length - 1)) * 100);
}

/** Read one end of a span from the chosen source. */
function readSource(
  source: DateSource,
  item: TimelineItem,
  releaseEnd: string | null,
): string | null {
  if (source.kind === "release") return releaseEnd;
  const value = item.customFields[source.key];
  return typeof value === "string" && parseDay(value) !== null ? value : null;
}

/**
 * The span an item occupies under the chosen sources, or null when either end
 * cannot be resolved (the caller puts those in the undated tray).
 *
 * When a property source is selected and the item has no value for it, the
 * item is undated rather than silently falling back to its release. A bar that
 * looks like a due date but is really a release date is worse than an honest
 * gap, and the tray names the field so the gap is actionable.
 */
export function resolveItemSpan(
  item: TimelineItem,
  releaseSpan: Span | null,
  sources: DateSources,
): Span | null {
  const start = readSource(sources.start, item, releaseSpan?.start ?? null);
  const end = readSource(sources.end, item, releaseSpan?.end ?? null);
  if (start === null || end === null) return null;
  const startMs = parseDay(start);
  const endMs = parseDay(end);
  if (startMs === null || endMs === null) return null;
  // Mixed sources can put the end before the start (a due date earlier than the
  // release start). Clamp so the bar never runs backwards; the collapse to a
  // point is itself the signal that the two dates disagree.
  return endMs < startMs ? { start, end: start } : { start, end };
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
  /**
   * The release's own progress, 0-100: the mean of `itemProgressPct` over every
   * item at the active level scheduled into it, whatever their dates. Undated
   * items count, because they are still scope the release has to finish; a
   * release with nothing scheduled reads 0.
   */
  progressPct: number;
  /** How many items that mean was taken over, so the UI can say so. */
  itemCount: number;
}

/** Options that do not change the geometry, only what is drawn and how it fills. */
export interface TimelineOptions {
  /**
   * Workflow statuses in order (archived excluded), for leaf progress. Omitted,
   * every bar reads 0% and the UI simply draws no fill.
   */
  statusOrder?: readonly string[];
  /**
   * Drop shipped releases and the items scheduled into them. Those items are
   * removed outright rather than moved to the undated tray: they are dated, they
   * are just filtered out, and a tray that claimed otherwise would be a lie.
   */
  hideShipped?: boolean;
}

export interface TimelineModel {
  axis: TimeAxis;
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
  sources: DateSources = DEFAULT_DATE_SOURCES,
  scale: AxisScale = DEFAULT_AXIS_SCALE,
  options: TimelineOptions = {},
): TimelineModel | null {
  const { statusOrder = [], hideShipped = false } = options;
  const drawn = hideShipped
    ? releases.filter((r) => r.status !== "shipped")
    : releases;
  // The releases deliberately left out, so their items can be left out too. An
  // item pointing at a release that is not in scope at all is a different case
  // and still belongs in the undated tray.
  const hiddenIds = new Set(
    releases.filter((r) => !drawn.includes(r)).map((r) => r.id),
  );

  const spans = new Map<string, Span>();
  for (const release of drawn) {
    const span = releaseSpan(release);
    if (span) spans.set(release.id, span);
  }

  // Resolve every item's own span first: under a property source a bar can sit
  // outside the release band it belongs to, which is exactly the slippage the
  // view exists to show, so the item's span is not derived from the group's.
  /** An item with its span resolved, before the axis exists to place it on. */
  type PlacedLater = { item: TimelineItem; span: Span };

  const byRelease = new Map<string, PlacedLater[]>();
  const undated: TimelineItem[] = [];
  const itemSpans: Span[] = [];
  /** Every item scheduled into a drawn release, dated or not: the progress base. */
  const scheduled = new Map<string, TimelineItem[]>();
  for (const item of items) {
    // A filtered-out release takes its items with it (see hideShipped).
    if (item.releaseId && hiddenIds.has(item.releaseId)) continue;
    if (item.releaseId) {
      const all = scheduled.get(item.releaseId);
      if (all) all.push(item);
      else scheduled.set(item.releaseId, [item]);
    }
    const release = item.releaseId ? spans.get(item.releaseId) ?? null : null;
    const span = resolveItemSpan(item, release, sources);
    // An item needs a resolvable span *and* a dated release to sit under, since
    // rows are grouped by release band.
    if (!span || !item.releaseId || !spans.has(item.releaseId)) {
      undated.push(item);
      continue;
    }
    itemSpans.push(span);
    const bucket = byRelease.get(item.releaseId);
    if (bucket) bucket.push({ item, span });
    else byRelease.set(item.releaseId, [{ item, span }]);
  }

  const visible = drawn.filter((release) => {
    if (!spans.has(release.id)) return false;
    if ((byRelease.get(release.id)?.length ?? 0) > 0) return true;
    return release.status !== "shipped";
  });

  // The axis has to cover the release bands *and* every item bar, since a bar
  // driven by a custom date field can fall outside its release.
  const axis = buildAxis(
    [
      ...visible.map((r) => spans.get(r.id)).filter((s): s is Span => s != null),
      ...itemSpans,
    ],
    today,
    scale,
  );
  if (!axis) return null;

  const groups: TimelineGroup[] = [];
  for (const release of visible) {
    const span = spans.get(release.id);
    if (!span) continue;
    const placement = projectSpan(span, axis);
    if (!placement) continue;
    const rows: TimelineRow[] = [];
    for (const { item, span: itemSpan } of byRelease.get(release.id) ?? []) {
      const itemPlacement = projectSpan(itemSpan, axis);
      if (itemPlacement) {
        rows.push({ item, span: itemSpan, placement: itemPlacement });
      }
    }
    const contributing = scheduled.get(release.id) ?? [];
    const progressPct =
      contributing.length === 0
        ? 0
        : Math.round(
            contributing.reduce(
              (sum, item) => sum + itemProgressPct(item, statusOrder),
              0,
            ) / contributing.length,
          );
    groups.push({
      release,
      span,
      placement,
      rows,
      progressPct,
      itemCount: contributing.length,
    });
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
