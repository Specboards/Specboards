import { describe, expect, it } from "vitest";

import {
  activityWindow,
  changeKindLabel,
  dailySeries,
  formatDuration,
  resolveRange,
  share,
  unrecordedDays,
} from "@/lib/activity-report";

/**
 * The activity report's failure mode is not looking wrong, it is looking right
 * while being wrong. Two cases carry that risk and are covered hardest here:
 * days before the ledger existed must not read as days of no work, and a stage
 * average must never appear without the sample count behind it.
 */

describe("dailySeries", () => {
  const window = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-06T00:00:00.000Z" };

  it("fills the quiet days the store omits", () => {
    const days = dailySeries(
      { byDay: [{ day: "2026-08-03", count: 4 }], since: "2026-08-01T09:00:00.000Z" },
      window,
    );
    expect(days.map((d) => d.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    // Without the fill the chart would put 4 next to nothing and close the gap,
    // making a five-day window look like a one-day one.
    expect(days.map((d) => d.count)).toEqual([0, 0, 4, 0, 0]);
  });

  it("separates days with no changes from days with no recording", () => {
    const days = dailySeries(
      { byDay: [{ day: "2026-08-05", count: 2 }], since: "2026-08-04T13:00:00.000Z" },
      window,
    );
    // The whole point: 1-3 August are zero because nobody was writing it down,
    // and the 4th is zero because nothing happened. Same number, different
    // claim, and only one of them is about the team's output.
    expect(days.map((d) => d.recorded)).toEqual([false, false, false, true, true]);
    expect(unrecordedDays(days)).toBe(3);
  });

  it("counts the day recording began as recorded", () => {
    const days = dailySeries(
      { byDay: [], since: "2026-08-03T23:59:00.000Z" },
      window,
    );
    expect(days.find((d) => d.day === "2026-08-03")?.recorded).toBe(true);
    expect(days.find((d) => d.day === "2026-08-02")?.recorded).toBe(false);
  });

  it("treats an empty ledger as recording nothing, not as a quiet window", () => {
    const days = dailySeries({ byDay: [], since: null }, window);
    expect(days.every((d) => !d.recorded)).toBe(true);
    expect(unrecordedDays(days)).toBe(5);
  });
});

describe("activityWindow", () => {
  it("runs to the end of today so today's changes are in it", () => {
    const w = activityWindow(7, new Date("2026-08-08T14:30:00.000Z"));
    expect(w.to).toBe("2026-08-09T00:00:00.000Z");
    expect(w.from).toBe("2026-08-02T00:00:00.000Z");
  });

  it("covers exactly the number of days asked for", () => {
    const w = activityWindow(30, new Date("2026-08-08T00:00:01.000Z"));
    const days = dailySeries({ byDay: [], since: null }, w);
    expect(days).toHaveLength(30);
  });
});

describe("resolveRange", () => {
  it("falls back rather than erroring on an unknown range", () => {
    expect(resolveRange("999").days).toBe(30);
    expect(resolveRange(undefined).days).toBe(30);
    expect(resolveRange("7").days).toBe(7);
  });
});

describe("formatDuration", () => {
  it("picks a unit the reader does not have to divide", () => {
    expect(formatDuration(0.5)).toBe("30 minutes");
    expect(formatDuration(6.53)).toBe("6.5 hours");
    expect(formatDuration(412)).toBe("17.2 days");
  });

  it("does not round a real span down to nothing", () => {
    // A stage that took seconds still took time; "0 minutes" would read as an
    // unmeasured stage rather than a fast one.
    expect(formatDuration(0.001)).toBe("1 minute");
  });

  it("says singular when it is one", () => {
    expect(formatDuration(1)).toBe("1 hour");
    expect(formatDuration(24)).toBe("24 hours");
  });
});

describe("changeKindLabel", () => {
  it("names a field change by what the field is called in prose", () => {
    expect(changeKindLabel("item.field_changed", "assigneeId")).toBe("Assignee");
    expect(changeKindLabel("item.field_changed", "riceReach")).toBe("RICE reach");
  });

  it("names the document events that carry no field", () => {
    expect(changeKindLabel("spec.body_changed", null)).toBe("Spec rewritten");
    expect(changeKindLabel("spec.moved", null)).toBe("Spec moved");
  });

  it("shows an unknown field rather than nothing", () => {
    // A field added since this shipped names itself rather than disappearing
    // from the breakdown and quietly unbalancing the totals.
    expect(changeKindLabel("item.field_changed", "somethingNew")).toBe("SomethingNew");
  });
});

describe("share", () => {
  it("is zero rather than NaN when there is nothing to divide", () => {
    expect(share(0, 0)).toBe(0);
    expect(share(3, 12)).toBe(25);
  });
});
