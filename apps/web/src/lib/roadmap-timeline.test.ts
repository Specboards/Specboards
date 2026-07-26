import { describe, expect, it } from "vitest";

import {
  buildMonthAxis,
  buildTimeline,
  formatSpan,
  parseDay,
  projectDay,
  projectSpan,
  releaseSpan,
  type TimelineItem,
  type TimelineRelease,
} from "./roadmap-timeline";

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

function item(specId: string, releaseId: string | null): TimelineItem {
  return {
    specId,
    title: specId,
    status: "backlog",
    level: "feature",
    releaseId,
    productId: "p1",
  };
}

describe("parseDay", () => {
  it("parses a YYYY-MM-DD day as UTC", () => {
    expect(parseDay("2026-07-26")).toBe(Date.UTC(2026, 6, 26));
  });

  it("returns null for absent or malformed input", () => {
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay("26-07-2026")).toBeNull();
    expect(parseDay("2026-07-26T00:00:00Z")).toBeNull();
  });

  it("rejects out-of-range dates rather than rolling them over", () => {
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("2026-02-30")).toBeNull();
  });
});

describe("releaseSpan", () => {
  it("uses the planned start and target", () => {
    expect(
      releaseSpan(
        release("r", { startDate: "2026-07-01", targetDate: "2026-07-20" }),
      ),
    ).toEqual({ start: "2026-07-01", end: "2026-07-20" });
  });

  it("prefers the actual ship date as the end", () => {
    expect(
      releaseSpan(
        release("r", {
          startDate: "2026-07-01",
          targetDate: "2026-07-20",
          shippedDate: "2026-07-24",
        }),
      ),
    ).toEqual({ start: "2026-07-01", end: "2026-07-24" });
  });

  it("renders a target-only release as a point in time", () => {
    expect(releaseSpan(release("r", { targetDate: "2026-07-13" }))).toEqual({
      start: "2026-07-13",
      end: "2026-07-13",
    });
  });

  it("clamps a span that would run backwards", () => {
    // A release re-dated after shipping: ship date precedes the planned start.
    expect(
      releaseSpan(
        release("r", { startDate: "2026-07-20", shippedDate: "2026-07-01" }),
      ),
    ).toEqual({ start: "2026-07-20", end: "2026-07-20" });
  });

  it("returns null when the release carries no dates", () => {
    expect(releaseSpan(release("r"))).toBeNull();
  });

  it("returns null when the only date is malformed", () => {
    expect(releaseSpan(release("r", { targetDate: "not-a-date" }))).toBeNull();
  });
});

describe("buildMonthAxis", () => {
  it("pads the domain out to whole months", () => {
    const axis = buildMonthAxis([{ start: "2026-07-13", end: "2026-08-04" }]);
    expect(axis).not.toBeNull();
    expect(axis!.startMs).toBe(Date.UTC(2026, 6, 1));
    expect(axis!.endMs).toBe(Date.UTC(2026, 8, 1));
    expect(axis!.months.map((m) => m.key)).toEqual(["2026-07", "2026-08"]);
    expect(axis!.months.map((m) => m.label)).toEqual(["Jul 26", "Aug 26"]);
  });

  it("month widths sum to the full axis", () => {
    const axis = buildMonthAxis([{ start: "2026-01-05", end: "2026-12-20" }])!;
    const total = axis.months.reduce((a, m) => a + m.widthPct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it("stretches to include today so the marker is on-axis", () => {
    const axis = buildMonthAxis(
      [{ start: "2026-07-13", end: "2026-07-20" }],
      "2026-10-02",
    )!;
    expect(axis.endMs).toBe(Date.UTC(2026, 10, 1));
  });

  it("does not conjure an axis from today alone", () => {
    expect(buildMonthAxis([], "2026-07-26")).toBeNull();
  });

  it("returns null with nothing to draw", () => {
    expect(buildMonthAxis([])).toBeNull();
  });

  it("handles a large span set without spreading arguments", () => {
    const spans = Array.from({ length: 20_000 }, () => ({
      start: "2026-07-13",
      end: "2026-07-20",
    }));
    expect(() => buildMonthAxis(spans)).not.toThrow();
  });
});

describe("projectSpan", () => {
  const axis = buildMonthAxis([{ start: "2026-07-01", end: "2026-07-31" }])!;

  it("places a full-month span across the whole axis", () => {
    const p = projectSpan({ start: "2026-07-01", end: "2026-07-31" }, axis)!;
    expect(p.leftPct).toBeCloseTo(0, 6);
    expect(p.widthPct).toBeCloseTo(100, 6);
  });

  it("gives a single-day span real width (end is inclusive)", () => {
    const p = projectSpan({ start: "2026-07-01", end: "2026-07-01" }, axis)!;
    expect(p.leftPct).toBeCloseTo(0, 6);
    expect(p.widthPct).toBeCloseTo(100 / 31, 6);
  });

  it("clamps a bar so it cannot overhang the axis", () => {
    const p = projectSpan({ start: "2026-07-20", end: "2027-01-01" }, axis)!;
    expect(p.leftPct + p.widthPct).toBeLessThanOrEqual(100.000001);
  });
});

describe("projectDay", () => {
  const axis = buildMonthAxis([{ start: "2026-07-01", end: "2026-07-31" }])!;

  it("positions a day inside the axis", () => {
    expect(projectDay("2026-07-16", axis)).toBeCloseTo((15 / 31) * 100, 6);
  });

  it("returns null off-axis rather than pinning to an edge", () => {
    expect(projectDay("2026-06-30", axis)).toBeNull();
    expect(projectDay("2026-08-01", axis)).toBeNull();
    expect(projectDay(null, axis)).toBeNull();
  });
});

describe("buildTimeline", () => {
  const shipped = release("shipped", {
    status: "shipped",
    startDate: "2026-07-01",
    targetDate: "2026-07-13",
    shippedDate: "2026-07-13",
  });
  const planned = release("planned", {
    status: "planned",
    startDate: "2026-08-01",
    targetDate: "2026-08-20",
  });

  it("groups items under their release", () => {
    const model = buildTimeline(
      [item("a", "shipped"), item("b", "planned"), item("c", "planned")],
      [shipped, planned],
    )!;
    expect(model.groups.map((g) => g.release.id)).toEqual([
      "shipped",
      "planned",
    ]);
    expect(model.groups[0]!.rows.map((r) => r.item.specId)).toEqual(["a"]);
    expect(model.groups[1]!.rows.map((r) => r.item.specId)).toEqual([
      "b",
      "c",
    ]);
    expect(model.undated).toEqual([]);
  });

  it("collects unscheduled items in the undated tray, never dropping them", () => {
    const model = buildTimeline(
      [item("a", "planned"), item("b", null)],
      [planned],
    )!;
    expect(model.groups[0]!.rows).toHaveLength(1);
    expect(model.undated.map((i) => i.specId)).toEqual(["b"]);
  });

  it("treats an item on an undated release as undated", () => {
    const undatedRelease = release("no-dates");
    const model = buildTimeline(
      [item("a", "no-dates"), item("b", "planned")],
      [undatedRelease, planned],
    )!;
    expect(model.groups.map((g) => g.release.id)).toEqual(["planned"]);
    expect(model.undated.map((i) => i.specId)).toEqual(["a"]);
  });

  it("keeps an empty unshipped release but hides empty shipped history", () => {
    const model = buildTimeline([item("a", "planned")], [shipped, planned])!;
    expect(model.groups.map((g) => g.release.id)).toEqual(["planned"]);

    const withUpcomingOnly = buildTimeline([], [planned])!;
    expect(withUpcomingOnly.groups.map((g) => g.release.id)).toEqual([
      "planned",
    ]);
    expect(withUpcomingOnly.groups[0]!.rows).toEqual([]);
  });

  it("every item is either a bar or in the tray", () => {
    const items = [
      item("a", "shipped"),
      item("b", "planned"),
      item("c", null),
      item("d", "missing-release"),
    ];
    const model = buildTimeline(items, [shipped, planned])!;
    const drawn = model.groups.flatMap((g) =>
      g.rows.map((r) => r.item.specId),
    );
    expect([...drawn, ...model.undated.map((i) => i.specId)].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("returns null when no release in scope carries a date", () => {
    expect(buildTimeline([item("a", "x")], [release("x")])).toBeNull();
    expect(buildTimeline([], [])).toBeNull();
  });
});

describe("formatSpan", () => {
  it("formats a range", () => {
    expect(formatSpan({ start: "2026-07-13", end: "2026-07-26" })).toBe(
      "13 Jul to 26 Jul 2026",
    );
  });

  it("formats a single day", () => {
    expect(formatSpan({ start: "2026-07-13", end: "2026-07-13" })).toBe(
      "13 Jul 2026",
    );
  });
});
