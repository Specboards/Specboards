import { describe, expect, it } from "vitest";

import {
  DEFAULT_AXIS_SCALE,
  buildAxis,
  buildTimeline,
  dateSourceParam,
  parseAxisScale,
  formatSpan,
  parseDateSource,
  parseDay,
  projectDay,
  projectSpan,
  releaseSpan,
  resolveItemSpan,
  type DateSources,
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

function item(
  specId: string,
  releaseId: string | null,
  customFields: Record<string, unknown> = {},
): TimelineItem {
  return {
    specId,
    title: specId,
    status: "backlog",
    level: "feature",
    releaseId,
    productId: "p1",
    customFields,
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

describe("buildAxis", () => {
  it("pads the domain out to whole months", () => {
    const axis = buildAxis([{ start: "2026-07-13", end: "2026-08-04" }]);
    expect(axis).not.toBeNull();
    expect(axis!.scale).toBe("month");
    expect(axis!.startMs).toBe(Date.UTC(2026, 6, 1));
    expect(axis!.endMs).toBe(Date.UTC(2026, 8, 1));
    expect(axis!.columns.map((m) => m.label)).toEqual(["Jul 26", "Aug 26"]);
  });

  it("column keys are unique per scale", () => {
    for (const scale of ["week", "month", "quarter"] as const) {
      const axis = buildAxis(
        [{ start: "2026-01-05", end: "2026-12-20" }],
        null,
        scale,
      )!;
      const keys = axis.columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("month widths sum to the full axis", () => {
    const axis = buildAxis([{ start: "2026-01-05", end: "2026-12-20" }])!;
    const total = axis.columns.reduce((a, m) => a + m.widthPct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it("stretches to include today so the marker is on-axis", () => {
    const axis = buildAxis(
      [{ start: "2026-07-13", end: "2026-07-20" }],
      "2026-10-02",
    )!;
    expect(axis.endMs).toBe(Date.UTC(2026, 10, 1));
  });

  it("does not conjure an axis from today alone", () => {
    expect(buildAxis([], "2026-07-26")).toBeNull();
  });

  it("returns null with nothing to draw", () => {
    expect(buildAxis([])).toBeNull();
  });

  it("handles a large span set without spreading arguments", () => {
    const spans = Array.from({ length: 20_000 }, () => ({
      start: "2026-07-13",
      end: "2026-07-20",
    }));
    expect(() => buildAxis(spans)).not.toThrow();
  });
});

describe("buildAxis at other scales", () => {
  it("pads a week axis out to whole Monday-to-Sunday weeks", () => {
    // 13 Jul 2026 is a Monday; 22 Jul lands mid-week, so the axis runs to the
    // following Monday.
    const axis = buildAxis(
      [{ start: "2026-07-15", end: "2026-07-22" }],
      null,
      "week",
    )!;
    expect(axis.scale).toBe("week");
    expect(axis.startMs).toBe(Date.UTC(2026, 6, 13));
    expect(axis.endMs).toBe(Date.UTC(2026, 6, 27));
    expect(axis.columns.map((c) => c.label)).toEqual(["13 Jul", "20 Jul"]);
  });

  it("starts a week column on Monday whichever day the span starts", () => {
    for (const [day, monday] of [
      ["2026-07-13", Date.UTC(2026, 6, 13)], // Monday itself
      ["2026-07-19", Date.UTC(2026, 6, 13)], // Sunday belongs to the week before
      ["2026-07-20", Date.UTC(2026, 6, 20)],
    ] as const) {
      const axis = buildAxis([{ start: day, end: day }], null, "week")!;
      expect(axis.startMs).toBe(monday);
    }
  });

  it("pads a quarter axis out to whole quarters", () => {
    const axis = buildAxis(
      [{ start: "2026-02-10", end: "2026-08-01" }],
      null,
      "quarter",
    )!;
    expect(axis.startMs).toBe(Date.UTC(2026, 0, 1));
    expect(axis.endMs).toBe(Date.UTC(2026, 9, 1));
    expect(axis.columns.map((c) => c.label)).toEqual([
      "Q1 26",
      "Q2 26",
      "Q3 26",
    ]);
  });

  it("column widths sum to the full axis at every scale", () => {
    for (const scale of ["week", "month", "quarter"] as const) {
      const axis = buildAxis(
        [{ start: "2026-01-05", end: "2027-03-20" }],
        null,
        scale,
      )!;
      const total = axis.columns.reduce((a, c) => a + c.widthPct, 0);
      expect(total).toBeCloseTo(100, 6);
    }
  });

  it("steps out to a coarser scale when the range is too long to draw", () => {
    // Ten years of weeks would be ~520 columns; the axis reports what it drew.
    const axis = buildAxis(
      [{ start: "2020-01-01", end: "2030-01-01" }],
      null,
      "week",
    )!;
    expect(axis.scale).toBe("quarter");
    expect(axis.columns.length).toBeLessThanOrEqual(120);
  });

  it("keeps the requested scale when the range fits", () => {
    const axis = buildAxis(
      [{ start: "2026-01-01", end: "2026-06-30" }],
      null,
      "week",
    )!;
    expect(axis.scale).toBe("week");
  });

  it("draws a very long range at the coarsest scale rather than refusing", () => {
    const axis = buildAxis(
      [{ start: "1990-01-01", end: "2090-01-01" }],
      null,
      "quarter",
    )!;
    expect(axis.scale).toBe("quarter");
    expect(axis.columns.length).toBeGreaterThan(120);
  });
});

describe("parseAxisScale", () => {
  it("accepts the known scales", () => {
    expect(parseAxisScale("week")).toBe("week");
    expect(parseAxisScale("month")).toBe("month");
    expect(parseAxisScale("quarter")).toBe("quarter");
  });

  it("falls back to the default for anything else", () => {
    expect(parseAxisScale(undefined)).toBe(DEFAULT_AXIS_SCALE);
    expect(parseAxisScale("")).toBe(DEFAULT_AXIS_SCALE);
    expect(parseAxisScale("day")).toBe(DEFAULT_AXIS_SCALE);
    expect(parseAxisScale("WEEK")).toBe(DEFAULT_AXIS_SCALE);
  });

  it("takes the first value from a repeated param", () => {
    expect(parseAxisScale(["quarter", "week"])).toBe("quarter");
  });
});

describe("projectSpan", () => {
  const axis = buildAxis([{ start: "2026-07-01", end: "2026-07-31" }])!;

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
  const axis = buildAxis([{ start: "2026-07-01", end: "2026-07-31" }])!;

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

describe("parseDateSource", () => {
  const keys = ["due_date", "kickoff"];

  it("defaults to the release span", () => {
    expect(parseDateSource(undefined, keys)).toEqual({ kind: "release" });
    expect(parseDateSource("release", keys)).toEqual({ kind: "release" });
  });

  it("resolves a known custom property", () => {
    expect(parseDateSource("cf:due_date", keys)).toEqual({
      kind: "property",
      key: "due_date",
    });
  });

  it("falls back to the release for a property that no longer exists", () => {
    // A stale bookmark should degrade to the default view, not an empty one.
    expect(parseDateSource("cf:deleted_field", keys)).toEqual({
      kind: "release",
    });
  });

  it("does not let a property named `release` collide with the reserved value", () => {
    expect(parseDateSource("cf:release", ["release"])).toEqual({
      kind: "property",
      key: "release",
    });
    expect(parseDateSource("release", ["release"])).toEqual({ kind: "release" });
  });

  it("takes the first value from a repeated param", () => {
    expect(parseDateSource(["cf:due_date", "cf:kickoff"], keys)).toEqual({
      kind: "property",
      key: "due_date",
    });
  });

  it("round-trips through dateSourceParam", () => {
    for (const raw of ["release", "cf:due_date"]) {
      expect(dateSourceParam(parseDateSource(raw, keys))).toBe(raw);
    }
  });
});

describe("resolveItemSpan", () => {
  const release = { start: "2026-07-01", end: "2026-07-20" };
  const both = (k: string): DateSources => ({
    start: { kind: "property", key: k },
    end: { kind: "property", key: k },
  });

  it("uses the release span by default", () => {
    expect(
      resolveItemSpan(item("a", "r"), release, {
        start: { kind: "release" },
        end: { kind: "release" },
      }),
    ).toEqual(release);
  });

  it("reads a date custom field when selected", () => {
    expect(
      resolveItemSpan(item("a", "r", { due: "2026-08-05" }), release, both("due")),
    ).toEqual({ start: "2026-08-05", end: "2026-08-05" });
  });

  it("mixes sources: release start to a due date", () => {
    expect(
      resolveItemSpan(item("a", "r", { due: "2026-08-05" }), release, {
        start: { kind: "release" },
        end: { kind: "property", key: "due" },
      }),
    ).toEqual({ start: "2026-07-01", end: "2026-08-05" });
  });

  it("is undated when the selected field is missing, rather than falling back", () => {
    // A bar that looks like a due date but is really a release date would be
    // worse than an honest gap.
    expect(resolveItemSpan(item("a", "r"), release, both("due"))).toBeNull();
  });

  it("is undated when the field holds a non-date value", () => {
    expect(
      resolveItemSpan(item("a", "r", { due: "soon" }), release, both("due")),
    ).toBeNull();
    expect(
      resolveItemSpan(item("a", "r", { due: 20260805 }), release, both("due")),
    ).toBeNull();
  });

  it("clamps when the end resolves earlier than the start", () => {
    // A due date before the release start: collapse to a point rather than
    // drawing a backwards bar.
    expect(
      resolveItemSpan(item("a", "r", { due: "2026-06-01" }), release, {
        start: { kind: "release" },
        end: { kind: "property", key: "due" },
      }),
    ).toEqual({ start: "2026-07-01", end: "2026-07-01" });
  });

  it("is undated with no release when a release source is selected", () => {
    expect(
      resolveItemSpan(item("a", null), null, {
        start: { kind: "release" },
        end: { kind: "release" },
      }),
    ).toBeNull();
  });
});

describe("buildTimeline with a custom date source", () => {
  const planned: TimelineRelease = {
    id: "planned",
    name: "planned",
    status: "planned",
    startDate: "2026-07-01",
    targetDate: "2026-07-20",
    shippedDate: null,
  };
  const byDue: DateSources = {
    start: { kind: "property", key: "due" },
    end: { kind: "property", key: "due" },
  };

  it("plots items by the custom field and trays the ones missing it", () => {
    const model = buildTimeline(
      [
        item("has", "planned", { due: "2026-07-10" }),
        item("missing", "planned"),
      ],
      [planned],
      "2026-07-05",
      byDue,
    )!;
    expect(model.groups[0]!.rows.map((r) => r.item.specId)).toEqual(["has"]);
    expect(model.groups[0]!.rows[0]!.span).toEqual({
      start: "2026-07-10",
      end: "2026-07-10",
    });
    expect(model.undated.map((i) => i.specId)).toEqual(["missing"]);
  });

  it("stretches the axis to cover a bar outside its release band", () => {
    // The point of plotting by due date: slippage past the release is visible,
    // so the axis has to reach it rather than clipping it away.
    const model = buildTimeline(
      [item("late", "planned", { due: "2026-09-15" })],
      [planned],
      null,
      byDue,
    )!;
    expect(model.axis.columns.at(-1)!.label).toBe("Sep 26");
    const row = model.groups[0]!.rows[0]!;
    // The bar sits after the release band it belongs to.
    expect(row.placement.leftPct).toBeGreaterThan(
      model.groups[0]!.placement.leftPct + model.groups[0]!.placement.widthPct,
    );
  });

  it("still counts every item as either a bar or a tray entry", () => {
    const model = buildTimeline(
      [
        item("a", "planned", { due: "2026-07-10" }),
        item("b", "planned"),
        item("c", null, { due: "2026-07-11" }),
      ],
      [planned],
      null,
      byDue,
    )!;
    const drawn = model.groups.flatMap((g) => g.rows.map((r) => r.item.specId));
    expect([...drawn, ...model.undated.map((i) => i.specId)].sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
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
