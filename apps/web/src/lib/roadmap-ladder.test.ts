import { describe, expect, it } from "vitest";

import {
  LADDER_DEPTH,
  atRisk,
  buildLadder,
  progressPct,
  visibleRows,
  type BuildLadderInput,
  type LadderItem,
} from "./roadmap-ladder";
import type { TimelineRelease } from "./roadmap-timeline";

const LEVELS = ["initiative", "epic", "feature", "work"];
const STATUSES = ["backlog", "defining", "ready", "in_progress", "done"];

function item(
  specId: string,
  level: string,
  overrides: Partial<LadderItem> = {},
): LadderItem {
  return {
    specId,
    title: specId,
    status: "backlog",
    level,
    releaseId: null,
    productId: "p1",
    customFields: {},
    parentSpecId: null,
    childCount: 0,
    childDoneCount: 0,
    ...overrides,
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

const r1 = release("r1", {
  startDate: "2026-07-01",
  targetDate: "2026-07-20",
});
const r2 = release("r2", {
  startDate: "2026-08-01",
  targetDate: "2026-08-31",
});

function build(
  items: LadderItem[],
  overrides: Partial<BuildLadderInput> = {},
) {
  return buildLadder({
    items,
    releases: [r1, r2],
    activeLevel: "initiative",
    levelOrder: LEVELS,
    statusOrder: STATUSES,
    blockingEdges: [],
    today: "2026-07-15",
    ...overrides,
  });
}

describe("buildLadder rows", () => {
  it("ladders children under their parent in pre-order", () => {
    const model = build([
      item("i1", "initiative"),
      item("e1", "epic", { parentSpecId: "i1", releaseId: "r1" }),
      item("f1", "feature", { parentSpecId: "e1", releaseId: "r1" }),
    ])!;
    expect(model.rows.map((r) => [r.item.specId, r.depth])).toEqual([
      ["i1", 0],
      ["e1", 1],
      ["f1", 2],
    ]);
  });

  it("rolls a parent's span up from its descendants", () => {
    const model = build([
      item("i1", "initiative"),
      item("e1", "epic", { parentSpecId: "i1", releaseId: "r1" }),
      item("e2", "epic", { parentSpecId: "i1", releaseId: "r2" }),
    ])!;
    const initiative = model.rows.find((r) => r.item.specId === "i1")!;
    expect(initiative.span).toEqual({ start: "2026-07-01", end: "2026-08-31" });
    expect(initiative.derived).toBe(true);
  });

  it("prefers an item's own dates over a rolled-up span", () => {
    const model = build([
      item("i1", "initiative", { releaseId: "r1" }),
      item("e1", "epic", { parentSpecId: "i1", releaseId: "r2" }),
    ])!;
    const initiative = model.rows.find((r) => r.item.specId === "i1")!;
    expect(initiative.span).toEqual({ start: "2026-07-01", end: "2026-07-20" });
    expect(initiative.derived).toBe(false);
  });

  it("rolls up from below the rendered depth", () => {
    // Work items are one level past LADDER_DEPTH from an initiative, so they are
    // never drawn, but a parent with no dates of its own must still get a bar.
    expect(LADDER_DEPTH).toBe(3);
    const model = build([
      item("i1", "initiative"),
      item("e1", "epic", { parentSpecId: "i1" }),
      item("f1", "feature", { parentSpecId: "e1" }),
      item("w1", "work", { parentSpecId: "f1", releaseId: "r2" }),
    ])!;
    expect(model.rows.map((r) => r.item.specId)).toEqual(["i1", "e1", "f1"]);
    for (const row of model.rows) {
      expect(row.span).toEqual({ start: "2026-08-01", end: "2026-08-31" });
      expect(row.derived).toBe(true);
    }
  });

  it("trays an item with no dates anywhere beneath it", () => {
    const model = build([
      item("i1", "initiative", { releaseId: "r1" }),
      item("i2", "initiative"),
      item("e2", "epic", { parentSpecId: "i2" }),
    ])!;
    expect(model.rows.map((r) => r.item.specId)).toEqual(["i1"]);
    expect(model.undated.map((i) => i.specId).sort()).toEqual(["e2", "i2"]);
  });

  it("counts rendered children so a row knows about its disclosure", () => {
    const model = build([
      item("i1", "initiative", { releaseId: "r1" }),
      item("e1", "epic", { parentSpecId: "i1", releaseId: "r1" }),
      item("e2", "epic", { parentSpecId: "i1", releaseId: "r1" }),
    ])!;
    const initiative = model.rows.find((r) => r.item.specId === "i1")!;
    expect(initiative.childRowCount).toBe(2);
    expect(model.rows.find((r) => r.item.specId === "e1")!.childRowCount).toBe(0);
  });

  it("ignores a parent outside the readable set", () => {
    // The parent is not in `items` (a product the viewer cannot read), so the
    // child must not be hung off a row that is not there.
    const model = build([
      item("e1", "epic", { parentSpecId: "missing", releaseId: "r1" }),
    ], { activeLevel: "epic" })!;
    expect(model.rows.map((r) => r.item.specId)).toEqual(["e1"]);
    expect(model.rows[0]!.depth).toBe(0);
  });

  it("survives a parent cycle instead of hanging", () => {
    const model = build(
      [
        item("a", "epic", { parentSpecId: "b" }),
        item("b", "epic", { parentSpecId: "a" }),
        item("c", "epic", { releaseId: "r1" }),
      ],
      { activeLevel: "epic" },
    )!;
    expect(model.rows.map((r) => r.item.specId)).toEqual(["c"]);
  });

  it("returns null when nothing in scope can be placed", () => {
    expect(build([item("i1", "initiative")], { releases: [] })).toBeNull();
  });

  it("draws release bands on the same axis as the bars", () => {
    const model = build([
      item("i1", "initiative", { releaseId: "r1" }),
    ])!;
    expect(model.bands.map((b) => b.release.id)).toEqual(["r1", "r2"]);
    for (const band of model.bands) {
      expect(band.placement.leftPct).toBeGreaterThanOrEqual(0);
      expect(band.placement.leftPct + band.placement.widthPct).toBeLessThanOrEqual(
        100.000001,
      );
    }
  });
});

describe("buildLadder edges", () => {
  const items = [
    item("i1", "initiative", { releaseId: "r1", productId: "p1" }),
    item("i2", "initiative", { releaseId: "r2", productId: "p2" }),
    item("i3", "initiative", { productId: "p1" }),
  ];

  it("keeps only edges between two drawn bars", () => {
    const model = build(items, {
      blockingEdges: [
        { blockerSpecId: "i1", blockedSpecId: "i2" },
        // i3 is undated, so it is never drawn: an edge to it has no endpoint.
        { blockerSpecId: "i1", blockedSpecId: "i3" },
        { blockerSpecId: "i1", blockedSpecId: "gone" },
      ],
    })!;
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]!.blockedSpecId).toBe("i2");
  });

  it("flags a cross-product edge", () => {
    const model = build(items, {
      blockingEdges: [{ blockerSpecId: "i1", blockedSpecId: "i2" }],
    })!;
    expect(model.edges[0]!.crossProduct).toBe(true);
  });

  it("is not late when the blocker finishes before the blocked work starts", () => {
    // r1 ends 20 Jul; r2 starts 1 Aug.
    const model = build(items, {
      blockingEdges: [{ blockerSpecId: "i1", blockedSpecId: "i2" }],
    })!;
    expect(model.edges[0]!.late).toBe(false);
  });

  it("is late when the blocker ends after the blocked work starts", () => {
    const model = build(items, {
      blockingEdges: [{ blockerSpecId: "i2", blockedSpecId: "i1" }],
    })!;
    expect(model.edges[0]!.late).toBe(true);
  });
});

describe("progressPct", () => {
  it("reads a parent from its children, over all of them", () => {
    expect(
      progressPct(
        item("i", "initiative", { childCount: 4, childDoneCount: 1 }),
        STATUSES,
      ),
    ).toBe(25);
  });

  it("reads a leaf from its position in the workflow", () => {
    expect(progressPct(item("w", "work", { status: "backlog" }), STATUSES)).toBe(0);
    expect(
      progressPct(item("w", "work", { status: "in_progress" }), STATUSES),
    ).toBe(75);
    expect(progressPct(item("w", "work", { status: "done" }), STATUSES)).toBe(100);
  });

  it("is zero for a status the workflow does not know", () => {
    expect(progressPct(item("w", "work", { status: "wat" }), STATUSES)).toBe(0);
  });
});

describe("atRisk", () => {
  const span = { start: "2026-07-01", end: "2026-07-10" };

  it("flags unfinished work whose end has passed", () => {
    expect(atRisk(span, 50, "2026-07-15")).toBe(true);
  });

  it("does not flag finished work", () => {
    expect(atRisk(span, 100, "2026-07-15")).toBe(false);
  });

  it("does not flag work still inside its span", () => {
    expect(atRisk(span, 50, "2026-07-05")).toBe(false);
  });
});

describe("visibleRows", () => {
  const model = () =>
    build([
      item("i1", "initiative", { releaseId: "r1" }),
      item("e1", "epic", { parentSpecId: "i1", releaseId: "r1" }),
      item("f1", "feature", { parentSpecId: "e1", releaseId: "r1" }),
      item("i2", "initiative", { releaseId: "r2" }),
    ])!;

  it("shows everything with nothing collapsed", () => {
    expect(visibleRows(model().rows, new Set()).map((r) => r.item.specId)).toEqual(
      ["i1", "e1", "f1", "i2"],
    );
  });

  it("hides a collapsed row's whole subtree, not just its children", () => {
    expect(
      visibleRows(model().rows, new Set(["i1"])).map((r) => r.item.specId),
    ).toEqual(["i1", "i2"]);
  });

  it("hides only the deeper level when a middle row is collapsed", () => {
    expect(
      visibleRows(model().rows, new Set(["e1"])).map((r) => r.item.specId),
    ).toEqual(["i1", "e1", "i2"]);
  });
});
