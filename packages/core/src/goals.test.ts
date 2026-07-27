import { describe, expect, it } from "vitest";

import {
  buildGoalTree,
  compareGoals,
  deliveryProgress,
  flattenGoalTree,
  formatMetric,
  goalProgress,
  goalsForProduct,
  isGoalClosed,
  keyResultProgress,
  validateGoalPeriod,
  validateKeyResult,
  wouldCreateGoalCycle,
  type GoalStatus,
} from "./goals.js";

const num = (start: number, target: number, current: number) => ({
  metricKind: "number" as const,
  startValue: start,
  targetValue: target,
  currentValue: current,
});

describe("keyResultProgress", () => {
  it("measures distance travelled from start to target, not toward target alone", () => {
    // The naive current/target would say 67% here; nothing has been achieved.
    expect(keyResultProgress(num(40, 60, 40))).toBe(0);
    expect(keyResultProgress(num(40, 60, 50))).toBe(50);
    expect(keyResultProgress(num(40, 60, 60))).toBe(100);
  });

  it("handles a decreasing metric with no special case", () => {
    // "Reduce churn from 8% to 3%": direction falls out of the arithmetic.
    expect(keyResultProgress(num(8, 3, 8))).toBe(0);
    expect(keyResultProgress(num(8, 3, 5.5))).toBe(50);
    expect(keyResultProgress(num(8, 3, 3))).toBe(100);
  });

  it("clamps overshoot and regression", () => {
    expect(keyResultProgress(num(0, 100, 150))).toBe(100);
    expect(keyResultProgress(num(0, 100, -20))).toBe(0);
    // A decreasing metric that got worse than its baseline.
    expect(keyResultProgress(num(8, 3, 12))).toBe(0);
  });

  it("treats a boolean key result as done or not", () => {
    const bool = (current: number) => ({
      metricKind: "boolean" as const,
      startValue: 0,
      targetValue: 1,
      currentValue: current,
    });
    expect(keyResultProgress(bool(0))).toBe(0);
    expect(keyResultProgress(bool(1))).toBe(100);
  });

  it("returns null for a degenerate measure rather than inventing a number", () => {
    expect(keyResultProgress(num(50, 50, 50))).toBeNull();
  });
});

describe("goalProgress", () => {
  it("averages its key results", () => {
    expect(goalProgress([num(0, 100, 100), num(0, 100, 0)])).toBe(50);
    expect(goalProgress([num(0, 10, 2), num(0, 10, 4), num(0, 10, 9)])).toBe(50);
  });

  it("is null with no key results, not 0", () => {
    // A goal written before it is made measurable is a valid state, and "not
    // measured" is a different claim from "no progress".
    expect(goalProgress([])).toBeNull();
  });

  it("ignores degenerate key results instead of poisoning the mean", () => {
    expect(goalProgress([num(0, 100, 100), num(50, 50, 50)])).toBe(100);
  });
});

describe("deliveryProgress", () => {
  it("is the share of contributing items that are done", () => {
    expect(
      deliveryProgress([{ done: true }, { done: false }, { done: false }, { done: true }]),
    ).toBe(50);
  });

  it("is null when nothing is linked", () => {
    expect(deliveryProgress([])).toBeNull();
  });

  it("stays separate from key-result progress", () => {
    // The failure mode OKRs exist to surface: all the work shipped, the metric
    // did not move. Two numbers, so it is visible.
    const krs = [num(0, 100, 0)];
    expect(goalProgress(krs)).toBe(0);
    expect(deliveryProgress([{ done: true }, { done: true }])).toBe(100);
  });
});

describe("formatMetric", () => {
  it("formats by kind", () => {
    expect(formatMetric(42.5, "number")).toBe("42.5");
    expect(formatMetric(42.5, "percent")).toBe("42.5%");
    expect(formatMetric(1, "boolean")).toBe("Yes");
    expect(formatMetric(0, "boolean")).toBe("No");
  });
});

describe("compareGoals", () => {
  const goal = (
    title: string,
    status: GoalStatus,
    periodEnd: string | null,
  ) => ({ title, status, periodEnd });

  it("puts open goals before judged ones, then soonest period end", () => {
    const sorted = [
      goal("Done well", "achieved", "2026-03-31"),
      goal("Later", "on_track", "2026-12-31"),
      goal("Sooner", "at_risk", "2026-09-30"),
      goal("Undated", "on_track", null),
    ].sort(compareGoals);
    expect(sorted.map((g) => g.title)).toEqual([
      "Sooner",
      "Later",
      "Undated",
      "Done well",
    ]);
  });
});

describe("isGoalClosed", () => {
  it("is true only once judged", () => {
    expect(isGoalClosed("on_track")).toBe(false);
    expect(isGoalClosed("off_track")).toBe(false);
    expect(isGoalClosed("achieved")).toBe(true);
    expect(isGoalClosed("missed")).toBe(true);
  });
});

describe("goalsForProduct", () => {
  it("returns the product's own goals plus org-wide ones", () => {
    const goals = [
      { productId: "alpha" },
      { productId: "beta" },
      { productId: null },
    ];
    expect(goalsForProduct(goals, "alpha")).toEqual([
      { productId: "alpha" },
      { productId: null },
    ]);
  });
});

describe("validateGoalPeriod", () => {
  it("allows an open-ended goal", () => {
    expect(validateGoalPeriod(null, null)).toBeNull();
    expect(validateGoalPeriod("2026-01-01", null)).toBeNull();
    expect(validateGoalPeriod(null, "2026-12-31")).toBeNull();
  });

  it("rejects a period that ends before it starts", () => {
    expect(validateGoalPeriod("2026-12-31", "2026-01-01")).toMatch(
      /cannot end before it starts/,
    );
  });

  it("rejects a malformed date", () => {
    expect(validateGoalPeriod("Q1 2026", null)).toMatch(/periodStart/);
    expect(validateGoalPeriod(null, "31/12/2026")).toMatch(/periodEnd/);
  });
});

describe("validateKeyResult", () => {
  it("accepts an increasing and a decreasing metric", () => {
    expect(
      validateKeyResult({ metricKind: "number", startValue: 0, targetValue: 100 }),
    ).toBeNull();
    expect(
      validateKeyResult({ metricKind: "percent", startValue: 8, targetValue: 3 }),
    ).toBeNull();
  });

  it("rejects a target equal to its start", () => {
    expect(
      validateKeyResult({ metricKind: "number", startValue: 5, targetValue: 5 }),
    ).toMatch(/must differ/);
  });

  it("allows a boolean key result to share start and target", () => {
    expect(
      validateKeyResult({ metricKind: "boolean", startValue: 0, targetValue: 0 }),
    ).toBeNull();
  });
});

describe("wouldCreateGoalCycle", () => {
  const goals = [
    { id: "a", parentGoalId: null },
    { id: "b", parentGoalId: "a" },
    { id: "c", parentGoalId: "b" },
  ];

  it("rejects a goal parented to itself", () => {
    expect(wouldCreateGoalCycle(goals, "a", "a")).toBe(true);
  });

  it("rejects a goal parented under its own descendant", () => {
    expect(wouldCreateGoalCycle(goals, "a", "c")).toBe(true);
  });

  it("allows a legitimate reparent and detaching to the root", () => {
    expect(wouldCreateGoalCycle(goals, "c", "a")).toBe(false);
    expect(wouldCreateGoalCycle(goals, "c", null)).toBe(false);
  });
});

describe("buildGoalTree", () => {
  const goal = (
    id: string,
    parentGoalId: string | null,
    extra: Partial<{ status: GoalStatus; periodEnd: string | null; title: string }> = {},
  ) => ({
    id,
    parentGoalId,
    status: extra.status ?? ("on_track" as GoalStatus),
    periodEnd: extra.periodEnd ?? null,
    title: extra.title ?? id,
  });

  const ids = <T extends { id: string }>(rows: { goal: T }[]) =>
    rows.map((r) => r.goal.id);

  it("nests children under their parent, in reading order", () => {
    const rows = flattenGoalTree(
      buildGoalTree([
        goal("child-b", "root"),
        goal("root", null),
        goal("child-a", "root"),
        goal("grandchild", "child-a"),
      ]),
    );
    expect(ids(rows)).toEqual(["root", "child-a", "grandchild", "child-b"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
  });

  it("orders siblings by compareGoals at every level", () => {
    // Closed goals recede; among the open ones, the soonest period end wins.
    const rows = flattenGoalTree(
      buildGoalTree([
        goal("root", null),
        goal("done", "root", { status: "achieved", periodEnd: "2026-01-01" }),
        goal("later", "root", { periodEnd: "2026-12-31" }),
        goal("sooner", "root", { periodEnd: "2026-06-30" }),
      ]),
    );
    expect(ids(rows)).toEqual(["root", "sooner", "later", "done"]);
  });

  it("promotes a goal whose parent is out of scope, and says so", () => {
    // The everyday case: one product's goals, whose parent is another's.
    const nodes = buildGoalTree([goal("orphan", "elsewhere"), goal("root", null)]);
    const rows = flattenGoalTree(nodes);
    expect(ids(rows).sort()).toEqual(["orphan", "root"]);
    expect(rows.find((r) => r.goal.id === "orphan")?.orphaned).toBe(true);
    expect(rows.find((r) => r.goal.id === "root")?.orphaned).toBe(false);
  });

  it("keeps every goal in a cycle exactly once", () => {
    // wouldCreateGoalCycle stops this being written; if a row is corrupt
    // anyway, the goals still have to be reachable in the UI that repairs it.
    const rows = flattenGoalTree(
      buildGoalTree([goal("a", "b"), goal("b", "a"), goal("c", null)]),
    );
    expect(ids(rows).slice().sort()).toEqual(["a", "b", "c"]);
  });

  it("treats a goal parented to itself as a root", () => {
    const rows = flattenGoalTree(buildGoalTree([goal("self", "self")]));
    expect(ids(rows)).toEqual(["self"]);
    expect(rows[0].depth).toBe(0);
  });

  it("returns nothing for no goals", () => {
    expect(buildGoalTree([])).toEqual([]);
    expect(flattenGoalTree([])).toEqual([]);
  });
});
