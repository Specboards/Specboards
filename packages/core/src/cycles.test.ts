import { describe, expect, it } from "vitest";

import {
  compareCycles,
  cycleDaysRemaining,
  cycleLengthDays,
  cycleState,
  cyclesForProduct,
  isCycleActive,
  selectableCycles,
  todayDateOnly,
  validateCycleDates,
} from "./cycles.js";

const sprint = { startDate: "2026-07-20", endDate: "2026-07-31" };

describe("cycleState", () => {
  it("is upcoming before the start date", () => {
    expect(cycleState(sprint, "2026-07-19")).toBe("upcoming");
  });

  it("is active on the start date (inclusive)", () => {
    expect(cycleState(sprint, "2026-07-20")).toBe("active");
  });

  it("is active on the end date (inclusive)", () => {
    expect(cycleState(sprint, "2026-07-31")).toBe("active");
  });

  it("is complete the day after the end date, with nothing having run", () => {
    // The whole point of deriving rather than storing: no cron, no write on
    // read, and the cycle is correct the instant the clock passes it.
    expect(cycleState(sprint, "2026-08-01")).toBe("complete");
  });

  it("handles a single-day cycle", () => {
    const oneDay = { startDate: "2026-07-20", endDate: "2026-07-20" };
    expect(cycleState(oneDay, "2026-07-19")).toBe("upcoming");
    expect(cycleState(oneDay, "2026-07-20")).toBe("active");
    expect(cycleState(oneDay, "2026-07-21")).toBe("complete");
  });

  it("compares across month and year boundaries", () => {
    const yearEnd = { startDate: "2026-12-28", endDate: "2027-01-08" };
    expect(cycleState(yearEnd, "2026-12-31")).toBe("active");
    expect(cycleState(yearEnd, "2027-01-08")).toBe("active");
    expect(cycleState(yearEnd, "2027-01-09")).toBe("complete");
  });
});

describe("isCycleActive", () => {
  it("agrees with cycleState", () => {
    expect(isCycleActive(sprint, "2026-07-25")).toBe(true);
    expect(isCycleActive(sprint, "2026-08-25")).toBe(false);
  });
});

describe("cycleDaysRemaining", () => {
  it("counts today as a remaining day", () => {
    expect(cycleDaysRemaining(sprint, "2026-07-31")).toBe(1);
    expect(cycleDaysRemaining(sprint, "2026-07-30")).toBe(2);
  });

  it("is 0 once the cycle is over", () => {
    expect(cycleDaysRemaining(sprint, "2026-08-01")).toBe(0);
  });

  it("counts the full length for a cycle that has not started", () => {
    expect(cycleDaysRemaining(sprint, "2026-07-01")).toBe(12);
  });
});

describe("cycleLengthDays", () => {
  it("counts both ends", () => {
    expect(cycleLengthDays(sprint)).toBe(12);
    expect(
      cycleLengthDays({ startDate: "2026-07-20", endDate: "2026-07-20" }),
    ).toBe(1);
  });
});

describe("compareCycles", () => {
  it("puts active first, then upcoming soonest, then most recently complete", () => {
    const today = "2026-07-25";
    const active = { name: "S3", startDate: "2026-07-20", endDate: "2026-07-31" };
    const soon = { name: "S4", startDate: "2026-08-01", endDate: "2026-08-14" };
    const later = { name: "S5", startDate: "2026-08-15", endDate: "2026-08-28" };
    const old = { name: "S1", startDate: "2026-06-01", endDate: "2026-06-14" };
    const recent = { name: "S2", startDate: "2026-07-01", endDate: "2026-07-14" };

    const sorted = [old, later, active, recent, soon].sort((a, b) =>
      compareCycles(a, b, today),
    );
    expect(sorted.map((c) => c.name)).toEqual(["S3", "S4", "S5", "S2", "S1"]);
  });

  it("breaks ties on name so the order is stable", () => {
    const today = "2026-07-25";
    const a = { name: "Beta", startDate: "2026-08-01", endDate: "2026-08-14" };
    const b = { name: "Alpha", startDate: "2026-08-01", endDate: "2026-08-14" };
    expect([a, b].sort((x, y) => compareCycles(x, y, today)).map((c) => c.name)).toEqual(
      ["Alpha", "Beta"],
    );
  });
});

describe("selectableCycles", () => {
  const cycles = [
    { id: "done", startDate: "2026-06-01", endDate: "2026-06-14" },
    { id: "now", startDate: "2026-07-20", endDate: "2026-07-31" },
    { id: "next", startDate: "2026-08-01", endDate: "2026-08-14" },
  ];

  it("drops finished cycles", () => {
    expect(
      selectableCycles(cycles, null, "2026-07-25").map((c) => c.id),
    ).toEqual(["now", "next"]);
  });

  it("keeps the item's current cycle even once it has finished", () => {
    // Otherwise an item sitting in a closed cycle would read as unscheduled.
    expect(
      selectableCycles(cycles, "done", "2026-07-25").map((c) => c.id),
    ).toEqual(["done", "now", "next"]);
  });
});

describe("cyclesForProduct", () => {
  it("returns the product's own cycles plus workspace-wide ones", () => {
    const cycles = [
      { productId: "alpha" },
      { productId: "beta" },
      { productId: null },
    ];
    expect(cyclesForProduct(cycles, "alpha")).toEqual([
      { productId: "alpha" },
      { productId: null },
    ]);
  });
});

describe("validateCycleDates", () => {
  it("accepts a well-formed range", () => {
    expect(validateCycleDates("2026-07-20", "2026-07-31")).toBeNull();
  });

  it("accepts a single-day cycle", () => {
    expect(validateCycleDates("2026-07-20", "2026-07-20")).toBeNull();
  });

  it("rejects an end before the start", () => {
    expect(validateCycleDates("2026-07-31", "2026-07-20")).toMatch(
      /cannot end before it starts/,
    );
  });

  it("rejects a malformed date", () => {
    expect(validateCycleDates("20/07/2026", "2026-07-31")).toMatch(/startDate/);
    expect(validateCycleDates("2026-07-20", "not-a-date")).toMatch(/endDate/);
  });
});

describe("todayDateOnly", () => {
  it("formats as YYYY-MM-DD in UTC", () => {
    expect(todayDateOnly(new Date("2026-07-27T23:30:00Z"))).toBe("2026-07-27");
  });

  it("does not shift the day for a late-UTC instant", () => {
    expect(todayDateOnly(new Date("2026-01-01T00:00:01Z"))).toBe("2026-01-01");
  });
});
