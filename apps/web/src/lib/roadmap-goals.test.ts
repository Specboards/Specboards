import { describe, expect, it } from "vitest";

import { buildGoalTimeline, goalSpan, type TimelineGoal } from "./roadmap-goals";
import type { TimelineItem, TimelineRelease } from "./roadmap-timeline";

function goal(id: string, over: Partial<TimelineGoal> = {}): TimelineGoal {
  return {
    id,
    title: id,
    status: "on_track",
    productId: null,
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    progress: null,
    deliveryProgress: null,
    linkedItemCount: 0,
    ...over,
  };
}

function release(
  id: string,
  dates: Partial<TimelineRelease> = {},
): TimelineRelease {
  return {
    id,
    name: id,
    status: "planned",
    startDate: null,
    targetDate: null,
    shippedDate: null,
    ...dates,
  };
}

function item(
  specId: string,
  releaseId: string | null,
  over: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    specId,
    title: specId,
    status: "backlog",
    level: "feature",
    releaseId,
    productId: null,
    customFields: {},
    ...over,
  };
}

/** A release spanning Q1, so items scheduled into it resolve a span. */
const q1 = release("q1", { startDate: "2026-01-05", targetDate: "2026-03-20" });

describe("goalSpan", () => {
  it("uses the goal's measurement period", () => {
    expect(
      goalSpan({ periodStart: "2026-01-01", periodEnd: "2026-03-31" }),
    ).toEqual({ start: "2026-01-01", end: "2026-03-31" });
  });

  it("draws a one-ended goal as a point rather than dropping it", () => {
    // An objective with a deadline and no stated start is normal.
    expect(goalSpan({ periodStart: null, periodEnd: "2026-06-30" })).toEqual({
      start: "2026-06-30",
      end: "2026-06-30",
    });
    expect(goalSpan({ periodStart: "2026-06-30", periodEnd: null })).toEqual({
      start: "2026-06-30",
      end: "2026-06-30",
    });
  });

  it("is null for an open-ended goal", () => {
    expect(goalSpan({ periodStart: null, periodEnd: null })).toBeNull();
  });

  it("clamps a period that ends before it starts", () => {
    expect(
      goalSpan({ periodStart: "2026-03-31", periodEnd: "2026-01-01" }),
    ).toEqual({ start: "2026-03-31", end: "2026-03-31" });
  });
});

describe("buildGoalTimeline", () => {
  it("draws one lane per dated goal, holding its linked work", () => {
    const model = buildGoalTimeline({
      goals: [goal("g1"), goal("g2", { periodEnd: "2026-06-30" })],
      items: [item("a", "q1"), item("b", "q1")],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "a" },
        { goalId: "g2", specId: "b" },
      ],
      today: "2026-02-01",
    });
    expect(model).not.toBeNull();
    expect(model!.lanes.map((l) => l.goal.id)).toEqual(["g1", "g2"]);
    expect(model!.lanes[0]!.rows.map((r) => r.item.specId)).toEqual(["a"]);
    expect(model!.lanes[1]!.rows.map((r) => r.item.specId)).toEqual(["b"]);
  });

  it("draws an item serving two goals in both lanes", () => {
    // The property that makes a lane not a partition: goal links are
    // many-to-many, so the rows cannot be assumed to be disjoint.
    const model = buildGoalTimeline({
      goals: [goal("g1"), goal("g2")],
      items: [item("shared", "q1")],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "shared" },
        { goalId: "g2", specId: "shared" },
      ],
    });
    expect(model!.lanes[0]!.rows.map((r) => r.item.specId)).toEqual(["shared"]);
    expect(model!.lanes[1]!.rows.map((r) => r.item.specId)).toEqual(["shared"]);
    expect(model!.unlinked).toEqual([]);
  });

  it("draws work from every level, not just one", () => {
    // A goal is served by an initiative and by a single work item alike.
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      items: [
        item("big", "q1", { level: "initiative" }),
        item("small", "q1", { level: "feature" }),
      ],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "big" },
        { goalId: "g1", specId: "small" },
      ],
    });
    expect(model!.lanes[0]!.rows.map((r) => r.item.level).sort()).toEqual([
      "feature",
      "initiative",
    ]);
  });

  it("keeps a goal with no period out of the lanes but not out of the model", () => {
    const model = buildGoalTimeline({
      goals: [
        goal("dated"),
        goal("open", { periodStart: null, periodEnd: null }),
      ],
      items: [],
      releases: [],
      links: [],
    });
    expect(model!.lanes.map((l) => l.goal.id)).toEqual(["dated"]);
    expect(model!.undatedGoals.map((g) => g.id)).toEqual(["open"]);
  });

  it("counts a goal's unplaceable work per lane rather than dropping it", () => {
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      // Scheduled into nothing, so under the release source it has no span.
      items: [item("dated", "q1"), item("floating", null)],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "dated" },
        { goalId: "g1", specId: "floating" },
      ],
    });
    expect(model!.lanes[0]!.rows.map((r) => r.item.specId)).toEqual(["dated"]);
    expect(model!.lanes[0]!.undatedCount).toBe(1);
  });

  it("still draws a lane whose goal has no work at all", () => {
    // The most important thing this view can say.
    const model = buildGoalTimeline({
      goals: [goal("empty")],
      items: [item("a", "q1")],
      releases: [q1],
      links: [],
    });
    expect(model!.lanes).toHaveLength(1);
    expect(model!.lanes[0]!.rows).toEqual([]);
  });

  it("collects work that ladders up to nothing", () => {
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      items: [item("served", "q1"), item("orphan", "q1")],
      releases: [q1],
      links: [{ goalId: "g1", specId: "served" }],
    });
    expect(model!.unlinked.map((i) => i.specId)).toEqual(["orphan"]);
  });

  it("ignores links pointing outside the sets it was given", () => {
    // Scoping happens upstream: a link to another product's goal, or to an item
    // filtered out of this view, must not resurrect either of them.
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      items: [item("a", "q1")],
      releases: [q1],
      links: [
        { goalId: "elsewhere", specId: "a" },
        { goalId: "g1", specId: "gone" },
      ],
    });
    expect(model!.lanes[0]!.rows).toEqual([]);
    // `a` is linked only to a goal outside this scope, so here it serves none.
    expect(model!.unlinked.map((i) => i.specId)).toEqual(["a"]);
  });

  it("draws a duplicated link once", () => {
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      items: [item("a", "q1")],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "a" },
        { goalId: "g1", specId: "a" },
      ],
    });
    expect(model!.lanes[0]!.rows).toHaveLength(1);
  });

  it("stretches the axis to cover work that runs past its goal's period", () => {
    // Exactly the slippage the view exists to show: the bar must not be clipped
    // to the band it sits in.
    const late = release("late", {
      startDate: "2026-05-01",
      targetDate: "2026-08-31",
    });
    const model = buildGoalTimeline({
      goals: [goal("g1", { periodStart: "2026-01-01", periodEnd: "2026-03-31" })],
      items: [item("slipped", "late")],
      releases: [late],
      links: [{ goalId: "g1", specId: "slipped" }],
    });
    const row = model!.lanes[0]!.rows[0]!;
    expect(row.span).toEqual({ start: "2026-05-01", end: "2026-08-31" });
    // Placed inside the axis, and starting after the goal band does.
    expect(row.placement.leftPct).toBeGreaterThan(
      model!.lanes[0]!.placement.leftPct,
    );
    expect(row.placement.leftPct + row.placement.widthPct).toBeLessThanOrEqual(
      100,
    );
  });

  it("is null when no goal in scope carries a period", () => {
    expect(
      buildGoalTimeline({
        goals: [goal("open", { periodStart: null, periodEnd: null })],
        items: [item("a", "q1")],
        releases: [q1],
        links: [{ goalId: "open", specId: "a" }],
      }),
    ).toBeNull();
    expect(
      buildGoalTimeline({ goals: [], items: [], releases: [], links: [] }),
    ).toBeNull();
  });

  it("resolves item spans from the selected date source", () => {
    const model = buildGoalTimeline({
      goals: [goal("g1")],
      items: [
        item("a", "q1", { customFields: { due: "2026-02-14" } }),
        item("b", "q1"),
      ],
      releases: [q1],
      links: [
        { goalId: "g1", specId: "a" },
        { goalId: "g1", specId: "b" },
      ],
      sources: { start: { kind: "release" }, end: { kind: "property", key: "due" } },
    });
    // `a` ends at its due date; `b` has no value for the field, so it is
    // undated here rather than falling back to the release end.
    expect(model!.lanes[0]!.rows.map((r) => r.span.end)).toEqual(["2026-02-14"]);
    expect(model!.lanes[0]!.undatedCount).toBe(1);
  });
});
