"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Target } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { statusDotColor, statusLabel } from "@/lib/feature-helpers";
import { goalStatusDotColor, goalStatusLabel } from "@/lib/goal-status";
import { orgProductPath } from "@/lib/org-path";
import type { GoalTimelineModel } from "@/lib/roadmap-goals";
import { formatSpan, projectDay } from "@/lib/roadmap-timeline";

import {
  COLUMN_PX,
  GUTTER_CLASS,
  GUTTER_PX,
  MIN_TRACK_PX,
} from "./timeline-geometry";
import { TimelineCollapseAll, Track } from "./roadmap-timeline";
import { TimelineScroller } from "./timeline-scroller";

/** How many unladdered items the tray names before it just counts them. */
const UNLINKED_SHOWN = 12;

/**
 * Roadmap timeline, grouped by goal: each objective's period as a band, with
 * the work laddering up to it drawn inside.
 *
 * The band fills with the goal's **outcome** progress, the mean of its key
 * results. Delivery is stated beside it as a number and is also visible as the
 * rows themselves, but the two are never averaged into one bar: a lane whose
 * work is all done and whose fill has not moved is the single most useful thing
 * this view can draw, and one merged bar would hide it.
 *
 * A lane is not a partition. An item serving two goals appears in both, so the
 * row counts here do not sum to the number of items in scope, and the view says
 * so rather than letting anyone total them up.
 */
export function RoadmapGoalLanes({
  model,
  org,
  productSlug,
  productNamesById,
  productKeysById,
  today,
  levelLabels = {},
  stateKey,
}: {
  model: GoalTimelineModel;
  org: string;
  productSlug: string;
  /** Product names for multi-product scopes; undefined for a single product. */
  productNamesById?: Record<string, string>;
  /** Product key by id, so a goal links to its own product's Goals page. */
  productKeysById?: Record<string, string>;
  /** Today as YYYY-MM-DD, resolved by the server so the marker is stable. */
  today: string;
  /** Level key to label, since a lane draws work from every level. */
  levelLabels?: Record<string, string>;
  /** Identifies this scope, so one timeline's collapse state is not another's. */
  stateKey: string;
}) {
  const { axis, lanes, undatedGoals, unlinked } = model;
  const widthPx = Math.max(
    MIN_TRACK_PX,
    axis.columns.length * COLUMN_PX[axis.scale],
  );
  const todayPct = projectDay(today, axis);
  const storageKey = `specboards.timeline.goals.${stateKey}`;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) setCollapsed(new Set(JSON.parse(saved) as string[]));
      else setCollapsed(new Set());
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

  const collapsibleIds = useMemo(
    () => lanes.filter((l) => l.rows.length > 0).map((l) => l.goal.id),
    [lanes],
  );
  const allCollapsed =
    collapsibleIds.length > 0 && collapsibleIds.every((id) => collapsed.has(id));

  function toggle(goalId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) next.delete(goalId);
      else next.add(goalId);
      return next;
    });
  }

  function itemHref(level: string, specId: string): string {
    return orgProductPath(org, productSlug, `/backlog/${level}/${specId}`);
  }

  /** A goal's own page: its product's, or the cross-product one if org-wide. */
  function goalHref(productId: string | null): string {
    const key = productId ? productKeysById?.[productId] : undefined;
    return orgProductPath(org, key ?? productSlug, "/goals");
  }

  const collapseAll =
    collapsibleIds.length > 0 ? (
      <TimelineCollapseAll
        allCollapsed={allCollapsed}
        onToggle={() =>
          setCollapsed(allCollapsed ? new Set() : new Set(collapsibleIds))
        }
      />
    ) : undefined;

  return (
    <div className="space-y-4">
      <TimelineScroller
        label="Roadmap timeline by goal"
        leading={collapseAll}
        focusPx={
          todayPct === null ? null : GUTTER_PX + (todayPct / 100) * widthPx
        }
      >
        <div className="w-max min-w-full">
          {/* Axis header. Two opaque layers for the same reason as the release
              timeline's: the sticky corner has to cover the labels sliding
              under it. */}
          <div className="flex border-b bg-muted/40">
            <div
              className={`${GUTTER_CLASS} sticky left-0 z-30 border-r bg-background`}
            >
              <div className="h-full bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                Goal
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

          {lanes.map((lane) => {
            const isCollapsed = collapsed.has(lane.goal.id);
            const expandable = lane.rows.length > 0;
            const outcome = lane.goal.progress;
            const delivery = lane.goal.deliveryProgress;
            return (
              <Fragment key={lane.goal.id}>
                {/* Goal band */}
                <div className="flex border-b bg-muted/20">
                  <div
                    className={`${GUTTER_CLASS} sticky left-0 z-20 border-r bg-background px-2 py-2`}
                  >
                    <div className="flex items-center gap-1">
                      {expandable ? (
                        <button
                          type="button"
                          onClick={() => toggle(lane.goal.id)}
                          aria-expanded={!isCollapsed}
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                          )}
                          <span className="sr-only">
                            {isCollapsed ? "Expand" : "Collapse"} the{" "}
                            {lane.goal.title} goal
                          </span>
                        </button>
                      ) : (
                        <span className="h-5 w-5 shrink-0" aria-hidden />
                      )}
                      <Target
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <Link
                        href={goalHref(lane.goal.productId)}
                        className="truncate text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={lane.goal.title}
                      >
                        {lane.goal.title}
                      </Link>
                    </div>
                    <div className="flex items-center gap-1.5 pl-6 text-2xs text-muted-foreground">
                      <span
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: goalStatusDotColor(lane.goal.status),
                        }}
                        aria-hidden
                      />
                      <span>{goalStatusLabel(lane.goal.status)}</span>
                      <span className="truncate">{formatSpan(lane.span)}</span>
                    </div>
                    {/* The two figures, named, in the gutter. The bar can only
                        carry one of them honestly, so the other is text. */}
                    <p className="pl-6 text-2xs text-muted-foreground">
                      Outcome {outcome === null ? "—" : `${outcome}%`} · Delivery{" "}
                      {delivery === null ? "—" : `${delivery}%`}
                      {lane.undatedCount > 0 ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {lane.undatedCount} undated
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <Track axis={axis} widthPx={widthPx} todayPct={todayPct}>
                    <div
                      className={`absolute overflow-hidden rounded-sm bg-secondary ${
                        isCollapsed ? "bottom-4 top-2" : "inset-y-2"
                      }`}
                      style={{
                        left: `${lane.placement.leftPct}%`,
                        width: `${lane.placement.widthPct}%`,
                        minWidth: "3px",
                      }}
                      title={`${formatSpan(lane.span)} · outcome ${
                        outcome === null ? "not measured" : `${outcome}%`
                      }`}
                      aria-hidden
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${outcome ?? 0}%`,
                          backgroundColor: goalStatusDotColor(lane.goal.status),
                        }}
                      />
                    </div>
                    {/* Collapsed, the work folds into the band as ticks, so the
                        shape of what serves the goal survives the fold. */}
                    {isCollapsed
                      ? lane.rows.map((row) => (
                          <div
                            key={row.item.specId}
                            className="absolute bottom-1.5 h-1.5 rounded-[1px] opacity-90"
                            style={{
                              left: `${row.placement.leftPct}%`,
                              width: `${row.placement.widthPct}%`,
                              minWidth: "3px",
                              backgroundColor: statusDotColor(row.item.status),
                            }}
                            title={`${row.item.title} · ${formatSpan(row.span)}`}
                            aria-hidden
                          />
                        ))
                      : null}
                  </Track>
                </div>

                {/* Contributing work */}
                {isCollapsed
                  ? null
                  : lane.rows.map((row) => (
                      <div
                        key={row.item.specId}
                        className="flex border-b last:border-b-0"
                      >
                        <div
                          className={`${GUTTER_CLASS} sticky left-0 z-20 border-r bg-background px-3 py-1.5 pl-8`}
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
                            {/* A lane draws every level, so each row says which. */}
                            <span className="truncate uppercase tracking-wide">
                              {levelLabels[row.item.level] ?? row.item.level}
                            </span>
                            {productNamesById && row.item.productId ? (
                              <span className="truncate">
                                {productNamesById[row.item.productId]}
                              </span>
                            ) : null}
                            <span className="sr-only">{formatSpan(row.span)}</span>
                          </div>
                        </div>
                        <Track
                          axis={axis}
                          widthPx={widthPx}
                          todayPct={todayPct}
                        >
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

                {lane.rows.length === 0 ? (
                  <div className="flex border-b last:border-b-0">
                    <div
                      className={`${GUTTER_CLASS} sticky left-0 z-20 border-r bg-background px-3 py-1.5 pl-8 text-2xs text-muted-foreground`}
                    >
                      {lane.goal.linkedItemCount > 0
                        ? "Nothing linked here can be placed on the axis"
                        : "No work linked to this goal yet"}
                    </div>
                    <Track axis={axis} widthPx={widthPx} todayPct={todayPct} />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </TimelineScroller>

      <p className="text-2xs text-muted-foreground">
        A goal band fills with its outcome progress: the mean of its key
        results. Delivery, the share of its work that is done, is stated beside
        it rather than merged in, because a goal that ships everything and moves
        no metric is the thing worth seeing. Work laddering up to two goals is
        drawn in both lanes, so the rows do not add up to the items in scope.
      </p>

      {undatedGoals.length > 0 ? (
        <section className="rounded-md border border-dashed p-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            No period set ({undatedGoals.length})
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            These goals have no start or end date, so there is nowhere on the
            axis to draw them. Give one a period on the Goals page.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {undatedGoals.map((goal) => (
              <li key={goal.id} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: goalStatusDotColor(goal.status) }}
                  aria-hidden
                />
                <Link
                  href={goalHref(goal.productId)}
                  className="truncate text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {goal.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {unlinked.length > 0 ? (
        <section className="rounded-md border border-dashed p-3">
          <h2 className="text-xs font-medium text-muted-foreground">
            Not laddered up ({unlinked.length})
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Work in scope that serves no goal here. Not a fault: plenty of work
            is maintenance or commitment. It is listed because a view of what
            the work is for should not quietly omit the part that answers
            nothing.
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {unlinked.slice(0, UNLINKED_SHOWN).map((item) => (
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
          {unlinked.length > UNLINKED_SHOWN ? (
            <p className="mt-1.5 text-2xs text-muted-foreground">
              Showing {UNLINKED_SHOWN} of {unlinked.length}.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Shown when no goal in scope carries a period, so there is no axis to draw. */
export function GoalTimelineEmptyState({
  hasGoals,
  action,
}: {
  /** True when goals exist but none is dated: a different fix from having none. */
  hasGoals: boolean;
  action?: React.ReactNode;
}) {
  return (
    <EmptyState
      className="mt-8"
      title="Nothing to plot yet"
      description={
        hasGoals
          ? "This view draws each goal over its measurement period. None of the goals in scope has a start or end date yet; set a period on one and its work appears here."
          : "This view draws each goal over its measurement period, with the work laddering up to it inside. Write a goal, give it a period, then link the work that should move it."
      }
      action={action}
    />
  );
}
