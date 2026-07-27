"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

import { StatusDot } from "@/components/status-dot";
import { statusDotColor, statusLabel } from "@/lib/feature-helpers";
import { orgProductPath } from "@/lib/org-path";
import {
  visibleRows,
  type LadderModel,
  type LadderRow,
} from "@/lib/roadmap-ladder";
import { formatSpan, projectDay } from "@/lib/roadmap-timeline";
import { TimelineCollapseAll } from "./roadmap-timeline";
import { COLUMN_PX, GUTTER_PX, MIN_TRACK_PX } from "./timeline-geometry";
import { TimelineScroller } from "./timeline-scroller";

/** Row height in px. Fixed, because the edge overlay positions by row index. */
const ROW_PX = 32;

/**
 * Portfolio timeline: the release timeline laddered across the hierarchy, with
 * `blocks` edges and progress.
 *
 * A client component only because expanding a row must not refetch the page:
 * the whole ladder arrives as props and collapse state is local, persisted per
 * scope in localStorage so an expansion survives navigating away and back
 * without putting view state in the URL (where every toggle would be a request).
 */
export function RoadmapLadder({
  model,
  org,
  productSlug,
  productNamesById,
  today,
  stateKey,
}: {
  model: LadderModel;
  org: string;
  productSlug: string;
  /** Product names for multi-product scopes; undefined when one product is in context. */
  productNamesById?: Record<string, string>;
  today: string;
  /** Identifies this scope+level, so one board's expansion is not another's. */
  stateKey: string;
}) {
  const { axis, rows, edges, bands, undated } = model;
  const widthPx = Math.max(
    MIN_TRACK_PX,
    axis.columns.length * COLUMN_PX[axis.scale],
  );
  const todayPct = projectDay(today, axis);
  const storageKey = `specboards.ladder.${stateKey}`;

  // Everything below the root level starts collapsed: an initiative row is the
  // altitude leadership reads first, and it expands on demand.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.childRowCount > 0).map((r) => r.item.specId)),
  );
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) setCollapsed(new Set(JSON.parse(saved) as string[]));
    } catch {
      // A quota-blocked or private-mode browser just gets the default shape.
    }
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
    } catch {
      // Persistence is a nicety; never let it break the view.
    }
  }, [collapsed, restored, storageKey]);

  const shown = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const indexBySpec = useMemo(
    () => new Map(shown.map((r, i) => [r.item.specId, i])),
    [shown],
  );

  // Blockers per row, for the text every blocked row carries: the edges are
  // drawn for scanning, but the relationship has to be readable without them.
  const blockersBySpec = useMemo(() => {
    const titleBySpec = new Map(rows.map((r) => [r.item.specId, r.item.title]));
    const out = new Map<string, string[]>();
    for (const edge of edges) {
      const title = titleBySpec.get(edge.blockerSpecId);
      if (!title) continue;
      const list = out.get(edge.blockedSpecId) ?? [];
      list.push(title);
      out.set(edge.blockedSpecId, list);
    }
    return out;
  }, [rows, edges]);

  // Only edges whose both ends are currently visible can be drawn; a collapsed
  // parent hides its children, and an edge into nothing would be a line to
  // nowhere.
  const drawnEdges = useMemo(
    () =>
      edges
        .map((edge) => {
          const from = indexBySpec.get(edge.blockerSpecId);
          const to = indexBySpec.get(edge.blockedSpecId);
          if (from === undefined || to === undefined) return null;
          const blocker = shown[from]!;
          const blocked = shown[to]!;
          return {
            edge,
            x1:
              ((blocker.placement.leftPct + blocker.placement.widthPct) / 100) *
              widthPx,
            y1: from * ROW_PX + ROW_PX / 2,
            x2: (blocked.placement.leftPct / 100) * widthPx,
            y2: to * ROW_PX + ROW_PX / 2,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null),
    [edges, indexBySpec, shown, widthPx],
  );

  function toggle(specId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(specId)) next.delete(specId);
      else next.add(specId);
      return next;
    });
  }

  // Expanding or collapsing the whole ladder in one action, rather than working
  // down a long list of chevrons.
  const collapsibleIds = useMemo(
    () => rows.filter((r) => r.childRowCount > 0).map((r) => r.item.specId),
    [rows],
  );
  const allCollapsed =
    collapsibleIds.length > 0 && collapsibleIds.every((id) => collapsed.has(id));
  const expandAll =
    collapsibleIds.length > 0 ? (
      <TimelineCollapseAll
        allCollapsed={allCollapsed}
        onToggle={() =>
          setCollapsed(allCollapsed ? new Set() : new Set(collapsibleIds))
        }
      />
    ) : undefined;

  function itemHref(row: LadderRow): string {
    return orgProductPath(
      org,
      productSlug,
      `/backlog/${row.item.level}/${row.item.specId}`,
    );
  }

  return (
    <div className="space-y-4">
      <TimelineScroller
        label="Portfolio timeline"
        leading={expandAll}
        focusPx={
          todayPct === null ? null : GUTTER_PX + (todayPct / 100) * widthPx
        }
      >
        <div className="w-max min-w-full">
          {/* Axis header, with the release bands named along it. */}
          <div className="flex border-b bg-muted/40">
            {/* Opaque in two layers, so the axis cannot show through the sticky
                corner cell as it scrolls past (see the release timeline). */}
            <div
              className="sticky left-0 z-30 shrink-0 border-r bg-background"
              style={{ width: `${GUTTER_PX}px` }}
            >
              <div className="h-full bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                Item
              </div>
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
              {/* Release names sit on the axis rather than owning a row each, so
                  the rows are all hierarchy. */}
              <div className="relative h-4">
                {bands.map((band) => (
                  <span
                    key={band.release.id}
                    className="absolute top-0 truncate px-1 text-2xs text-muted-foreground"
                    style={{
                      left: `${band.placement.leftPct}%`,
                      maxWidth: `${Math.max(band.placement.widthPct, 8)}%`,
                    }}
                  >
                    {band.release.name}
                  </span>
                ))}
              </div>
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

          <div className="relative">
            {/* Band shading and the today line run behind every row. */}
            <div
              className="pointer-events-none absolute inset-y-0 z-0"
              style={{ left: `${GUTTER_PX}px`, width: `${widthPx}px` }}
              aria-hidden
            >
              {bands.map((band) => (
                <div
                  key={band.release.id}
                  className="absolute inset-y-0 border-x border-border/60 bg-muted/20"
                  style={{
                    left: `${band.placement.leftPct}%`,
                    width: `${band.placement.widthPct}%`,
                  }}
                />
              ))}
              {todayPct !== null ? (
                <div
                  className="absolute inset-y-0 w-px bg-primary/70"
                  style={{ left: `${todayPct}%` }}
                />
              ) : null}
            </div>

            {/* Dependency edges, over the bars. Decorative: every blocked row
                names its blockers as text in the gutter. */}
            {drawnEdges.length > 0 ? (
              <svg
                className="pointer-events-none absolute inset-y-0 z-20"
                style={{ left: `${GUTTER_PX}px`, width: `${widthPx}px` }}
                height={shown.length * ROW_PX}
                width={widthPx}
                aria-hidden
              >
                {drawnEdges.map(({ edge, x1, y1, x2, y2 }) => (
                  <path
                    key={`${edge.blockerSpecId}:${edge.blockedSpecId}`}
                    d={edgePath(x1, y1, x2, y2)}
                    fill="none"
                    className={
                      edge.late
                        ? "stroke-[var(--warning)]"
                        : "stroke-muted-foreground/50"
                    }
                    strokeWidth={edge.late ? 1.5 : 1}
                    // A cross-product dependency is the one worth telling apart
                    // at a glance, so it is dashed.
                    strokeDasharray={edge.crossProduct ? "3 2" : undefined}
                  />
                ))}
              </svg>
            ) : null}

            {shown.map((row) => {
              const blockers = blockersBySpec.get(row.item.specId) ?? [];
              const expandable = row.childRowCount > 0;
              const isCollapsed = collapsed.has(row.item.specId);
              return (
                <div
                  key={row.item.specId}
                  className="relative z-10 flex border-b last:border-b-0"
                  style={{ height: `${ROW_PX}px` }}
                >
                  <div
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r bg-background px-2"
                    style={{
                      width: `${GUTTER_PX}px`,
                      paddingLeft: `${8 + row.depth * 14}px`,
                    }}
                  >
                    {expandable ? (
                      <button
                        type="button"
                        onClick={() => toggle(row.item.specId)}
                        aria-expanded={!isCollapsed}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                        )}
                        <span className="sr-only">
                          {isCollapsed ? "Expand" : "Collapse"} {row.item.title}
                        </span>
                      </button>
                    ) : (
                      <span className="h-6 w-6 shrink-0" aria-hidden />
                    )}
                    <StatusDot status={row.item.status} />
                    <Link
                      href={itemHref(row)}
                      className="truncate text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {row.item.title}
                    </Link>
                    {/* Product attribution on every row, in the multi-product
                        scopes where it carries information. */}
                    {productNamesById && row.item.productId ? (
                      <span className="ml-auto max-w-[38%] shrink-0 truncate text-2xs text-muted-foreground">
                        {productNamesById[row.item.productId]}
                      </span>
                    ) : null}
                    {/* Everything a sighted reader gets from the bar, as text. */}
                    <span className="sr-only">
                      {statusLabel(row.item.status)}, {formatSpan(row.span)}
                      {row.derived ? ", rolled up from its children" : ""}
                      {row.progressPct > 0 ? `, ${row.progressPct}% complete` : ""}
                      {row.atRisk ? ", at risk" : ""}
                      {productNamesById && row.item.productId
                        ? `, ${productNamesById[row.item.productId]}`
                        : ""}
                      {blockers.length > 0
                        ? `, blocked by ${blockers.join(", ")}`
                        : ""}
                    </span>
                  </div>
                  <div
                    className="relative shrink-0"
                    style={{ width: `${widthPx}px` }}
                  >
                    <div
                      className={`absolute inset-y-1.5 overflow-hidden rounded-sm ${
                        row.derived
                          ? "border border-dashed border-muted-foreground/60 bg-muted/40"
                          : ""
                      }`}
                      style={{
                        left: `${row.placement.leftPct}%`,
                        width: `${row.placement.widthPct}%`,
                        minWidth: "3px",
                        backgroundColor: row.derived
                          ? undefined
                          : `${statusDotColor(row.item.status)}59`,
                      }}
                      title={`${formatSpan(row.span)} · ${row.progressPct}% complete${
                        row.atRisk ? " · at risk" : ""
                      }`}
                    >
                      {/* Fill: see the legend below for the one-sentence rule. */}
                      <div
                        className="h-full"
                        style={{
                          width: `${row.progressPct}%`,
                          backgroundColor: statusDotColor(row.item.status),
                        }}
                        aria-hidden
                      />
                    </div>
                    {row.atRisk ? (
                      <span
                        className="absolute top-1 h-2 w-2 -translate-x-1/2 rotate-45 bg-[var(--warning)]"
                        style={{
                          left: `${
                            row.placement.leftPct + row.placement.widthPct
                          }%`,
                        }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </TimelineScroller>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span>
          Fill shows progress: for a parent, how many of its children are done;
          for a leaf, how far its status has moved through the workflow.
        </span>
        <span>At risk: the bar&apos;s end date has passed and it is not done.</span>
        <span>A dashed bar is rolled up from an item&apos;s children.</span>
        {model.edges.length > 0 ? (
          <span>
            A dashed line is a dependency across products; a highlighted one
            starts before the work it waits on finishes.
          </span>
        ) : null}
      </div>

      {undated.length > 0 ? (
        <section className="rounded-md border border-dashed p-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            Undated ({undated.length})
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Not on the axis: neither these items nor anything beneath them has
            dates to plot.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {undated.map((item) => (
              <li key={item.specId} className="flex items-center gap-1.5">
                <StatusDot status={item.status} />
                <Link
                  href={orgProductPath(
                    org,
                    productSlug,
                    `/backlog/${item.level}/${item.specId}`,
                  )}
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
 * An orthogonal path from a blocker's end to the blocked item's start: out,
 * across, in. When the target starts before the blocker ends (the late case) the
 * path runs backwards, which is exactly what should look wrong.
 */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const stub = 8;
  const midX = x2 >= x1 + 2 * stub ? (x1 + x2) / 2 : x1 + stub;
  return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
}
