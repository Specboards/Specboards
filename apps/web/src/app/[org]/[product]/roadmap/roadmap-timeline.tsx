import { Fragment } from "react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { statusDotColor, statusLabel } from "@/lib/feature-helpers";
import { orgProductPath } from "@/lib/org-path";
import {
  DEFAULT_DATE_SOURCES,
  formatSpan,
  projectDay,
  type DateSources,
  type MonthAxis,
  type TimelineModel,
} from "@/lib/roadmap-timeline";

/** Minimum on-screen width of one month column, in px. */
const MONTH_PX = 116;
/** Minimum width of the whole track, so a one-month axis still reads as a time axis. */
const MIN_TRACK_PX = 640;
/** Left gutter width (release / item labels), in px. Must match GUTTER_CLASS. */
const GUTTER_CLASS = "w-56 shrink-0";

/**
 * The scrolling time track for one row: the month grid, the today marker, and
 * whatever bar the row draws on top. Purely presentational, so it is hidden
 * from assistive tech; every row states its dates as text in the gutter.
 */
function Track({
  axis,
  widthPx,
  todayPct,
  children,
}: {
  axis: MonthAxis;
  widthPx: number;
  todayPct: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative shrink-0" style={{ width: `${widthPx}px` }}>
      <div className="absolute inset-0 flex" aria-hidden>
        {axis.months.map((month) => (
          <div
            key={month.key}
            className="border-r border-border/60 last:border-r-0"
            style={{ width: `${month.widthPct}%` }}
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
 * on a month axis.
 *
 * Read-only by design in this slice. Dates are changed in the item detail and
 * release sheets, not by dragging here, so the view stays a server component
 * with no client bundle.
 *
 * Item bars currently take their span from the item's release, because items
 * carry no date columns of their own. The selectable date-source picker (release
 * span vs a `date` custom property) is the follow-on slice.
 */
export function RoadmapTimeline({
  model,
  org,
  productSlug,
  productNamesById,
  today,
  sources = DEFAULT_DATE_SOURCES,
  dateFieldLabels = {},
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
}) {
  const { axis, groups, undated } = model;
  const widthPx = Math.max(MIN_TRACK_PX, axis.months.length * MONTH_PX);
  const todayPct = projectDay(today, axis);

  function itemHref(level: string, specId: string): string {
    return orgProductPath(org, productSlug, `/backlog/${level}/${specId}`);
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <div className="w-max min-w-full">
          {/* Month header */}
          <div className="flex border-b bg-muted/40">
            <div
              className={`${GUTTER_CLASS} sticky left-0 z-20 border-r bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground`}
            >
              Release
            </div>
            <div className="relative shrink-0" style={{ width: `${widthPx}px` }}>
              <div className="flex">
                {axis.months.map((month) => (
                  <div
                    key={month.key}
                    className="border-r border-border/60 px-2 py-2 text-xs font-medium text-muted-foreground last:border-r-0"
                    style={{ width: `${month.widthPct}%` }}
                  >
                    {month.label}
                  </div>
                ))}
              </div>
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

/** Shown when no release in scope carries a date, so there is no axis to draw. */
export function TimelineEmptyState({ action }: { action?: React.ReactNode }) {
  return (
    <EmptyState
      className="mt-8"
      title="Nothing to plot yet"
      description="The timeline places items using the dates on the release they are scheduled into. Give a release a start or target date, then schedule work into it."
      action={action}
    />
  );
}
