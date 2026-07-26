import { Fragment } from "react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { statusDotColor, statusLabel } from "@/lib/feature-helpers";
import { orgProductPath } from "@/lib/org-path";
import {
  AXIS_SCALES,
  DEFAULT_AXIS_SCALE,
  DEFAULT_DATE_SOURCES,
  formatSpan,
  projectDay,
  type AxisScale,
  type DateSources,
  type TimeAxis,
  type TimelineModel,
} from "@/lib/roadmap-timeline";

import {
  COLUMN_PX,
  GUTTER_CLASS,
  MIN_TRACK_PX,
} from "./timeline-geometry";

/** Human label for a scale, used by the zoom control and its notices. */
const SCALE_LABELS: Record<AxisScale, string> = {
  week: "Weeks",
  month: "Months",
  quarter: "Quarters",
};

/**
 * The scrolling time track for one row: the column grid, the today marker, and
 * whatever bar the row draws on top. Purely presentational, so it is hidden
 * from assistive tech; every row states its dates as text in the gutter.
 */
function Track({
  axis,
  widthPx,
  todayPct,
  children,
}: {
  axis: TimeAxis;
  widthPx: number;
  todayPct: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative shrink-0" style={{ width: `${widthPx}px` }}>
      <div className="absolute inset-0 flex" aria-hidden>
        {axis.columns.map((column) => (
          <div
            key={column.key}
            className="border-r border-border/60 last:border-r-0"
            style={{ width: `${column.widthPct}%` }}
          />
        ))}
      </div>
      {todayPct !== null ? (
        <div
          className="absolute inset-y-0 z-10 w-px bg-primary/70"
          style={{ left: `${todayPct}%` }}
          aria-hidden
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Roadmap timeline (Gantt): releases and the items scheduled into them, drawn
 * on a week, month, or quarter axis.
 *
 * Read-only by design. Dates are changed in the item detail and release sheets,
 * not by dragging here, so the view stays a server component with no client
 * bundle.
 *
 * Bars take their span from the selected date sources (the item's release by
 * default, or a `date` custom property at either end); anything unplottable is
 * counted in the undated tray rather than dropped.
 */
export function RoadmapTimeline({
  model,
  org,
  productSlug,
  productNamesById,
  today,
  sources = DEFAULT_DATE_SOURCES,
  dateFieldLabels = {},
  requestedScale = DEFAULT_AXIS_SCALE,
}: {
  model: TimelineModel;
  org: string;
  productSlug: string;
  /** Product names for multi-product scopes; undefined when a single product is in context. */
  productNamesById?: Record<string, string>;
  /** Today as YYYY-MM-DD, resolved by the server so the marker is stable. */
  today: string;
  /** Which fields the bars are plotted from; drives the undated explanation. */
  sources?: DateSources;
  /** Property key to label, for naming the plotted fields in copy. */
  dateFieldLabels?: Record<string, string>;
  /** The zoom asked for, so a range too long to draw at it can say so. */
  requestedScale?: AxisScale;
}) {
  const { axis, groups, undated } = model;
  const widthPx = Math.max(
    MIN_TRACK_PX,
    axis.columns.length * COLUMN_PX[axis.scale],
  );
  const todayPct = projectDay(today, axis);
  const coarsened = axis.scale !== requestedScale;

  function itemHref(level: string, specId: string): string {
    return orgProductPath(org, productSlug, `/backlog/${level}/${specId}`);
  }

  return (
    <div className="space-y-4">
      {/*
        The requested zoom could not be drawn over this range, so the control and
        the axis disagree. Say which one won rather than leaving the user to
        wonder why "Weeks" produced month columns.
      */}
      {coarsened ? (
        <p className="text-2xs text-muted-foreground">
          This range is too long to draw in{" "}
          {SCALE_LABELS[requestedScale].toLowerCase()}, so it is shown in{" "}
          {SCALE_LABELS[axis.scale].toLowerCase()}.
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <div className="w-max min-w-full">
          {/* Axis header */}
          <div className="flex border-b bg-muted/40">
            <div
              className={`${GUTTER_CLASS} sticky left-0 z-20 border-r bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground`}
            >
              Release
            </div>
            <div className="relative shrink-0" style={{ width: `${widthPx}px` }}>
              <div className="flex">
                {axis.columns.map((column) => (
                  <div
                    key={column.key}
                    className="truncate border-r border-border/60 px-2 py-2 text-xs font-medium text-muted-foreground last:border-r-0"
                    style={{ width: `${column.widthPct}%` }}
                  >
                    {column.label}
                  </div>
                ))}
              </div>
              {/*
                Names the marker line that runs down every row below. Without it
                the line is an unexplained rule on the grid.
              */}
              {todayPct !== null ? (
                <div
                  className="pointer-events-none absolute bottom-0 z-20 -translate-x-1/2 whitespace-nowrap rounded-t-sm bg-primary px-1 text-2xs font-medium text-primary-foreground"
                  style={{ left: `${todayPct}%` }}
                >
                  Today
                </div>
              ) : null}
            </div>
          </div>

          {groups.map((group) => (
            <Fragment key={group.release.id}>
              {/* Release band */}
              <div className="flex border-b bg-muted/20">
                <div
                  className={`${GUTTER_CLASS} sticky left-0 z-10 border-r bg-background px-3 py-2`}
                >
                  <div className="truncate text-sm font-medium">
                    {group.release.name}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {formatSpan(group.span)}
                  </div>
                </div>
                <Track axis={axis} widthPx={widthPx} todayPct={todayPct}>
                  <div
                    className="absolute inset-y-2 rounded-sm bg-secondary"
                    style={{
                      left: `${group.placement.leftPct}%`,
                      width: `${group.placement.widthPct}%`,
                      minWidth: "3px",
                    }}
                    aria-hidden
                  />
                </Track>
              </div>

              {/* Item bars */}
              {group.rows.map((row) => (
                <div
                  key={row.item.specId}
                  className="flex border-b last:border-b-0"
                >
                  <div
                    className={`${GUTTER_CLASS} sticky left-0 z-10 border-r bg-background px-3 py-1.5 pl-6`}
                  >
                    <Link
                      href={itemHref(row.item.level, row.item.specId)}
                      className="block truncate text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {row.item.title}
                    </Link>
                    <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <StatusDot status={row.item.status} />
                      <span>{statusLabel(row.item.status)}</span>
                      {productNamesById && row.item.productId ? (
                        <span className="truncate">
                          {productNamesById[row.item.productId]}
                        </span>
                      ) : null}
                      <span className="sr-only">
                        {formatSpan(row.span)}
                      </span>
                    </div>
                  </div>
                  <Track axis={axis} widthPx={widthPx} todayPct={todayPct}>
                    <div
                      className="absolute inset-y-2 rounded-sm"
                      style={{
                        left: `${row.placement.leftPct}%`,
                        width: `${row.placement.widthPct}%`,
                        minWidth: "3px",
                        backgroundColor: statusDotColor(row.item.status),
                      }}
                      aria-hidden
                    />
                  </Track>
                </div>
              ))}

              {group.rows.length === 0 ? (
                <div className="flex border-b last:border-b-0">
                  <div
                    className={`${GUTTER_CLASS} sticky left-0 z-10 border-r bg-background px-3 py-1.5 pl-6 text-2xs text-muted-foreground`}
                  >
                    Nothing scheduled at this level
                  </div>
                  <Track axis={axis} widthPx={widthPx} todayPct={todayPct} />
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      </div>

      {/*
        Items that cannot be placed on the axis are counted here rather than
        dropped, so the timeline never implies coverage it does not have.
      */}
      {undated.length > 0 ? (
        <section className="rounded-md border border-dashed p-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            Undated ({undated.length})
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {undatedReason(sources, dateFieldLabels)}
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {undated.map((item) => (
              <li key={item.specId} className="flex items-center gap-1.5">
                <StatusDot status={item.status} />
                <Link
                  href={itemHref(item.level, item.specId)}
                  className="truncate text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Why the items in the tray could not be placed. Naming the actual fields
 * matters: under a custom date source "no due date" is a fixable gap in the
 * data, which reads very differently from "not scheduled into a release".
 */
function undatedReason(
  sources: DateSources,
  labels: Record<string, string>,
): string {
  const named = [sources.start, sources.end]
    .filter((s) => s.kind === "property")
    .map((s) => labels[(s as { key: string }).key] ?? (s as { key: string }).key);
  const unique = [...new Set(named)];
  if (unique.length === 0) {
    return "Not on the axis: these items are unscheduled, or their release has no dates.";
  }
  const fields =
    unique.length === 1
      ? unique[0]
      : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  return `Not on the axis: these items are unscheduled, or have no ${fields} set.`;
}

/**
 * Axis granularity control.
 *
 * Plain links rather than a client-side select: the zoom lives in `?zoom=`, so
 * each granularity is a link someone can send, it survives with JavaScript off,
 * and the control needs no client bundle. `withViewParams` carries the param, so
 * changing a filter or level keeps the zoom you chose.
 */
export function TimelineZoom({
  active,
  hrefs,
}: {
  active: AxisScale;
  hrefs: Record<AxisScale, string>;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Zoom</span>
      <div
        className="flex overflow-hidden rounded-md border"
        role="group"
        aria-label="Timeline zoom"
      >
        {AXIS_SCALES.map((scale) => (
          <Link
            key={scale}
            href={hrefs[scale]}
            aria-current={scale === active ? "true" : undefined}
            className={`border-r px-2.5 py-1.5 last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              scale === active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {SCALE_LABELS[scale]}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * How the timeline's rows are organized: grouped under release bands (the
 * single-product reading) or laddered down the hierarchy (the portfolio one).
 * Links, for the same reasons as the zoom control.
 */
export function TimelineRowsToggle({
  ladder,
  hrefs,
}: {
  ladder: boolean;
  hrefs: { releases: string; ladder: string };
}) {
  const options: { key: "releases" | "ladder"; label: string }[] = [
    { key: "releases", label: "By release" },
    { key: "ladder", label: "Laddered" },
  ];
  const active = ladder ? "ladder" : "releases";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Rows</span>
      <div
        className="flex overflow-hidden rounded-md border"
        role="group"
        aria-label="Timeline rows"
      >
        {options.map((option) => (
          <Link
            key={option.key}
            href={hrefs[option.key]}
            aria-current={option.key === active ? "true" : undefined}
            className={`border-r px-2.5 py-1.5 last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              option.key === active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {option.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Shown when nothing in scope can be placed on an axis, so there is none to draw. */
export function TimelineEmptyState({
  action,
  plottedByField = false,
}: {
  action?: React.ReactNode;
  /**
   * True when a custom date field is the selected source. The fix is then to fill
   * that field in (or plot by the release again), not to date a release, so the
   * copy must not send the user to the wrong place.
   */
  plottedByField?: boolean;
}) {
  return (
    <EmptyState
      className="mt-8"
      title="Nothing to plot yet"
      description={
        plottedByField
          ? "Nothing in scope has a value for the fields this timeline is plotted by. Set those dates on some items, or plot by the release span instead."
          : "The timeline places items using the dates on the release they are scheduled into. Give a release a start or target date, then schedule work into it."
      }
      action={action}
    />
  );
}
