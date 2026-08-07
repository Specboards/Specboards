import { describe, expect, it } from "vitest";

import {
  addDaysDateOnly,
  compareCycles,
  cycleDaysRemaining,
  cycleLengthDays,
  cycleScheduleRemainderDays,
  cycleState,
  cyclesForProduct,
  generateCycleSchedule,
  isCycleActive,
  MAX_GENERATED_CYCLES,
  nextCycleNumber,
  selectableCycles,
  todayDateOnly,
  validateCycleDates,
  validateCycleScheduleInput,
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

/** The card's worked example: fortnightly sprints from today to end of year. */
const fortnightly = {
  startDate: "2026-08-10",
  endDate: "2026-12-31",
  lengthDays: 14,
  nameTemplate: "Sprint {n}",
  startNumber: 1,
};

describe("addDaysDateOnly", () => {
  it("advances a date-only string", () => {
    expect(addDaysDateOnly("2026-08-10", 13)).toBe("2026-08-23");
  });

  it("crosses a month boundary", () => {
    expect(addDaysDateOnly("2026-08-24", 13)).toBe("2026-09-06");
  });

  it("crosses a year boundary", () => {
    expect(addDaysDateOnly("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("handles a leap day", () => {
    expect(addDaysDateOnly("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysDateOnly("2028-02-28", 2)).toBe("2028-03-01");
  });
});

describe("generateCycleSchedule", () => {
  it("generates back-to-back cycles that never overlap", () => {
    const planned = generateCycleSchedule(fortnightly);
    for (let i = 1; i < planned.length; i++) {
      // The next cycle starts the day after the previous ends. If this ever
      // becomes >= rather than >, two sprints claim the same day.
      expect(planned[i]!.startDate).toBe(
        addDaysDateOnly(planned[i - 1]!.endDate, 1),
      );
    }
  });

  it("makes every cycle exactly the requested length", () => {
    for (const c of generateCycleSchedule(fortnightly)) {
      expect(cycleLengthDays(c)).toBe(14);
    }
  });

  it("starts on the requested date and numbers from the requested number", () => {
    const planned = generateCycleSchedule(fortnightly);
    expect(planned[0]).toEqual({
      name: "Sprint 1",
      startDate: "2026-08-10",
      endDate: "2026-08-23",
    });
    expect(planned[1]!.name).toBe("Sprint 2");
  });

  it("never runs past the end date", () => {
    for (const c of generateCycleSchedule(fortnightly)) {
      expect(c.endDate <= fortnightly.endDate).toBe(true);
    }
  });

  it("omits a trailing partial cycle rather than emitting a stunted one", () => {
    // 2026-08-10 to 2026-12-31 is 144 days; ten fortnights fill 140 of them.
    const planned = generateCycleSchedule(fortnightly);
    expect(planned).toHaveLength(10);
    expect(planned[9]!.endDate).toBe("2026-12-27");
    expect(cycleScheduleRemainderDays(fortnightly)).toBe(4);
  });

  it("reports no remainder when the cadence divides the range evenly", () => {
    expect(
      cycleScheduleRemainderDays({ ...fortnightly, endDate: "2026-12-27" }),
    ).toBe(0);
  });

  it("continues the sequence from a given start number", () => {
    const planned = generateCycleSchedule({ ...fortnightly, startNumber: 6 });
    expect(planned[0]!.name).toBe("Sprint 6");
  });

  it("replaces every occurrence of the token", () => {
    const planned = generateCycleSchedule({
      ...fortnightly,
      nameTemplate: "S{n} (sprint {n})",
    });
    expect(planned[0]!.name).toBe("S1 (sprint 1)");
  });

  it("generates a single cycle when the range fits exactly one", () => {
    const planned = generateCycleSchedule({
      ...fortnightly,
      endDate: "2026-08-23",
    });
    expect(planned).toHaveLength(1);
  });

  it("returns nothing when the input is unusable", () => {
    expect(generateCycleSchedule({ ...fortnightly, lengthDays: 0 })).toEqual([]);
  });
});

describe("validateCycleScheduleInput", () => {
  it("accepts the worked example", () => {
    expect(validateCycleScheduleInput(fortnightly)).toBeNull();
  });

  it("rejects a cadence that does not fit the range at all", () => {
    expect(
      validateCycleScheduleInput({ ...fortnightly, endDate: "2026-08-20" }),
    ).toMatch(/end after the end date/);
  });

  it("rejects a template with no number token", () => {
    expect(
      validateCycleScheduleInput({ ...fortnightly, nameTemplate: "Sprint" }),
    ).toMatch(/\{n\}/);
  });

  it("rejects a non-whole or zero cycle length", () => {
    expect(validateCycleScheduleInput({ ...fortnightly, lengthDays: 0 })).toMatch(
      /at least 1/,
    );
    expect(
      validateCycleScheduleInput({ ...fortnightly, lengthDays: 2.5 }),
    ).toMatch(/whole number/);
  });

  it("rejects a run that would exceed the cap, before generating it", () => {
    // Daily cycles for five years: the guard exists so a slip like this is
    // refused rather than quietly inserting thousands of rows.
    expect(
      validateCycleScheduleInput({
        ...fortnightly,
        lengthDays: 1,
        endDate: "2031-12-31",
      }),
    ).toMatch(new RegExp(`more than ${MAX_GENERATED_CYCLES}`));
  });

  it("inherits the date validation used everywhere else", () => {
    expect(
      validateCycleScheduleInput({ ...fortnightly, endDate: "2026-01-01" }),
    ).toMatch(/cannot end before it starts/);
  });
});

describe("nextCycleNumber", () => {
  it("continues past the highest existing match", () => {
    expect(
      nextCycleNumber(["Sprint 1", "Sprint 5", "Sprint 3"], "Sprint {n}"),
    ).toBe(6);
  });

  it("starts at 1 when nothing matches", () => {
    expect(nextCycleNumber(["Q3 planning", "Hardening"], "Sprint {n}")).toBe(1);
  });

  it("starts at 1 for an empty workspace", () => {
    expect(nextCycleNumber([], "Sprint {n}")).toBe(1);
  });

  it("ignores names that only partly match the template", () => {
    expect(
      nextCycleNumber(["Sprint 9 (hardening)", "Sprint 2"], "Sprint {n}"),
    ).toBe(3);
  });

  it("treats regex characters in the template as literals", () => {
    // "Q3 (n)" must not be read as a regex group, and the escaped parens
    // must still match the real names.
    expect(nextCycleNumber(["C++ (7)", "C++ (2)"], "C++ ({n})")).toBe(8);
  });

  it("tolerates surrounding whitespace on stored names", () => {
    expect(nextCycleNumber(["  Sprint 4  "], "Sprint {n}")).toBe(5);
  });
});
