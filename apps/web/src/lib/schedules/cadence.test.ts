import { describe, expect, it } from "vitest";

import {
  CadenceError,
  describeCadence,
  isValidTimeZone,
  nextOccurrence,
  parseCadence,
  type Cadence,
} from "./cadence";

/**
 * When a schedule fires next.
 *
 * Almost every case here is a daylight-saving case, because that is the only
 * part of this that is hard and the only part that fails silently. A weekly
 * digest that drifts an hour twice a year is not reported by anybody; it is
 * just quietly wrong for six months, then quietly right again.
 *
 * The assertions are written against the LOCAL wall clock in the schedule's
 * own zone, because that is the promise being made. Asserting a UTC instant
 * would pass on an implementation that got the promise backwards, since the
 * expected instant would have been computed by the same broken arithmetic.
 */

/** What the clock says in `timeZone` at `instant`, as "YYYY-MM-DD HH:mm". */
function localOf(instant: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";
/** Half-hour offset, and no daylight saving at all. */
const KOLKATA = "Asia/Kolkata";

describe("nextOccurrence: the ordinary cases", () => {
  it("finds today's firing when it is still ahead", () => {
    const after = new Date("2026-03-10T08:00:00Z");
    const next = nextOccurrence({ every: "day", hour: 9, minute: 30 }, LONDON, after);
    expect(localOf(next, LONDON)).toBe("2026-03-10 09:30");
  });

  it("rolls to tomorrow when today's firing has passed", () => {
    const after = new Date("2026-03-10T10:00:00Z");
    const next = nextOccurrence({ every: "day", hour: 9, minute: 30 }, LONDON, after);
    expect(localOf(next, LONDON)).toBe("2026-03-11 09:30");
  });

  it("never returns the instant it was asked about", () => {
    // The dispatcher advances a schedule by asking for the next occurrence
    // after the one it just ran. Returning that same instant would make it due
    // again immediately and fire forever.
    const cadence: Cadence = { every: "day", hour: 9, minute: 0 };
    const fired = nextOccurrence(cadence, LONDON, new Date("2026-03-10T00:00:00Z"));
    const following = nextOccurrence(cadence, LONDON, fired);
    expect(following.getTime()).toBeGreaterThan(fired.getTime());
    expect(localOf(following, LONDON)).toBe("2026-03-11 09:00");
  });

  it("finds the next matching weekday", () => {
    // 2026-03-10 is a Tuesday; the next Monday is the 16th.
    const after = new Date("2026-03-10T12:00:00Z");
    const next = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      LONDON,
      after,
    );
    expect(localOf(next, LONDON)).toBe("2026-03-16 09:00");
  });

  it("keeps a half-hour-offset zone honest", () => {
    // Kolkata is UTC+05:30 and never changes, so it catches an implementation
    // that assumes whole-hour offsets without any daylight saving noise.
    const next = nextOccurrence(
      { every: "day", hour: 9, minute: 0 },
      KOLKATA,
      new Date("2026-03-10T00:00:00Z"),
    );
    expect(localOf(next, KOLKATA)).toBe("2026-03-10 09:00");
    expect(next.toISOString()).toBe("2026-03-10T03:30:00.000Z");
  });
});

describe("nextOccurrence: daylight saving", () => {
  it("keeps a weekly 09:00 at 09:00 across the spring change", () => {
    // British Summer Time began 2026-03-29. A schedule that stored a UTC
    // instant and added seven days would land at 08:00 local from here on.
    const before = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      LONDON,
      new Date("2026-03-22T12:00:00Z"),
    );
    expect(localOf(before, LONDON)).toBe("2026-03-23 09:00");

    const after = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      LONDON,
      before,
    );
    expect(localOf(after, LONDON)).toBe("2026-03-30 09:00");
    // The instants are 167 hours apart, not 168: that hour is the whole point.
    const hours = (after.getTime() - before.getTime()) / 3_600_000;
    expect(hours).toBe(167);
  });

  it("keeps a weekly 09:00 at 09:00 across the autumn change", () => {
    const before = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      LONDON,
      // A Sunday, so the next Monday firing is the 19th and the clocks go
      // back on the 25th, between that firing and the following one.
      new Date("2026-10-18T12:00:00Z"),
    );
    expect(localOf(before, LONDON)).toBe("2026-10-19 09:00");

    const after = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      LONDON,
      before,
    );
    expect(localOf(after, LONDON)).toBe("2026-10-26 09:00");
    // 169 hours, not 168: the repeated hour is the whole point.
    expect((after.getTime() - before.getTime()) / 3_600_000).toBe(169);
  });

  it("fires at the first real instant when the wall time does not exist", () => {
    // Clocks jumped 01:00 -> 02:00 in London on 2026-03-29, so 01:30 never
    // happened. Skipping the day would be the other option and it is worse: a
    // daily schedule that silently misses a day once a year.
    const next = nextOccurrence(
      { every: "day", hour: 1, minute: 30 },
      LONDON,
      new Date("2026-03-28T12:00:00Z"),
    );
    const local = localOf(next, LONDON);
    expect(local.startsWith("2026-03-29")).toBe(true);
    // Whatever it resolves to, it must be a real instant on that day at or
    // after the requested time, not before it.
    expect(next.getTime()).toBeGreaterThanOrEqual(
      Date.parse("2026-03-29T01:00:00Z"),
    );
  });

  it("fires once, not twice, when the wall time happens twice", () => {
    // Clocks went 02:00 -> 01:00 in London on 2026-10-25, so 01:30 occurred
    // twice. Firing on both would double every daily digest that morning.
    const first = nextOccurrence(
      { every: "day", hour: 1, minute: 30 },
      LONDON,
      new Date("2026-10-24T12:00:00Z"),
    );
    expect(localOf(first, LONDON)).toBe("2026-10-25 01:30");

    const second = nextOccurrence(
      { every: "day", hour: 1, minute: 30 },
      LONDON,
      first,
    );
    // The next firing is the following day, not the repeated hour.
    expect(localOf(second, LONDON)).toBe("2026-10-26 01:30");
  });

  it("does not skip the short day when asked late the night before", () => {
    // The trap this catches: walking forward by a fixed 24 hours rather than by
    // local calendar days. 2026-03-29 in London is 23 hours long, so 23:30 on
    // the 28th plus 24 hours lands at 00:30 on the 30th, and the 29th is never
    // considered at all. A daily schedule would silently miss a day, once a
    // year, in the direction nobody checks.
    const next = nextOccurrence(
      { every: "day", hour: 5, minute: 0 },
      LONDON,
      new Date("2026-03-28T23:30:00Z"),
    );
    expect(localOf(next, LONDON)).toBe("2026-03-29 05:00");
  });

  it("does the same in a zone that changes on different dates", () => {
    // New York changed on 2026-03-08, three weeks before London. A test only
    // ever run against one zone would pass on an implementation that had
    // London's dates hard-coded.
    const before = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      NEW_YORK,
      new Date("2026-03-02T18:00:00Z"),
    );
    expect(localOf(before, NEW_YORK)).toBe("2026-03-09 09:00");
    const after = nextOccurrence(
      { every: "week", weekday: 1, hour: 9, minute: 0 },
      NEW_YORK,
      before,
    );
    expect(localOf(after, NEW_YORK)).toBe("2026-03-16 09:00");
  });
});

describe("nextOccurrence: month ends", () => {
  it("clamps day 31 to the last day of a short month", () => {
    // Skipping April entirely is the alternative, and it is the one that
    // generates a support ticket.
    const next = nextOccurrence(
      { every: "month", day: 31, hour: 9, minute: 0 },
      LONDON,
      new Date("2026-04-02T00:00:00Z"),
    );
    expect(localOf(next, LONDON)).toBe("2026-04-30 09:00");
  });

  it("clamps to the 28th in a non-leap February and the 29th in a leap one", () => {
    expect(
      localOf(
        nextOccurrence(
          { every: "month", day: 30, hour: 9, minute: 0 },
          LONDON,
          new Date("2026-02-02T00:00:00Z"),
        ),
        LONDON,
      ),
    ).toBe("2026-02-28 09:00");

    expect(
      localOf(
        nextOccurrence(
          { every: "month", day: 30, hour: 9, minute: 0 },
          LONDON,
          new Date("2028-02-02T00:00:00Z"),
        ),
        LONDON,
      ),
    ).toBe("2028-02-29 09:00");
  });

  it("still fires on the 31st in a month that has one", () => {
    const next = nextOccurrence(
      { every: "month", day: 31, hour: 9, minute: 0 },
      LONDON,
      new Date("2026-05-02T00:00:00Z"),
    );
    expect(localOf(next, LONDON)).toBe("2026-05-31 09:00");
  });

  it("crosses a year boundary", () => {
    const next = nextOccurrence(
      { every: "month", day: 1, hour: 0, minute: 0 },
      LONDON,
      new Date("2026-12-15T00:00:00Z"),
    );
    expect(localOf(next, LONDON)).toBe("2027-01-01 00:00");
  });
});

describe("refusing what cannot be stored", () => {
  it("refuses a zone the runtime does not know", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone(LONDON)).toBe(true);
    expect(() =>
      nextOccurrence({ every: "day", hour: 9, minute: 0 }, "Mars/Olympus_Mons", new Date()),
    ).toThrow(CadenceError);
  });

  it("refuses an hour or minute outside the clock", () => {
    for (const bad of [-1, 24, 9.5]) {
      expect(() => parseCadence({ every: "day", hour: bad, minute: 0 })).toThrow(
        CadenceError,
      );
    }
    expect(() => parseCadence({ every: "day", hour: 9, minute: 60 })).toThrow(
      CadenceError,
    );
  });

  it("refuses a weekday or month day outside the calendar", () => {
    expect(() =>
      parseCadence({ every: "week", weekday: 7, hour: 9, minute: 0 }),
    ).toThrow(CadenceError);
    expect(() =>
      parseCadence({ every: "month", day: 0, hour: 9, minute: 0 }),
    ).toThrow(CadenceError);
    expect(() =>
      parseCadence({ every: "month", day: 32, hour: 9, minute: 0 }),
    ).toThrow(CadenceError);
  });

  it("refuses a cadence shape it does not know", () => {
    expect(() => parseCadence({ every: "fortnight", hour: 9 })).toThrow(CadenceError);
    expect(() => parseCadence(null)).toThrow(CadenceError);
    expect(() => parseCadence("weekly")).toThrow(CadenceError);
  });

  it("defaults a missing minute to zero rather than to NaN", () => {
    expect(parseCadence({ every: "day", hour: 9 })).toEqual({
      every: "day",
      hour: 9,
      minute: 0,
    });
  });
});

describe("describeCadence", () => {
  it("reads as the sentence somebody typed", () => {
    expect(describeCadence({ every: "week", weekday: 1, hour: 9, minute: 0 }, LONDON)).toBe(
      "Every Monday at 09:00 (Europe/London)",
    );
    expect(describeCadence({ every: "day", hour: 18, minute: 5 }, LONDON)).toBe(
      "Every day at 18:05 (Europe/London)",
    );
    expect(describeCadence({ every: "month", day: 1, hour: 7, minute: 0 }, LONDON)).toBe(
      "Monthly on day 1 at 07:00 (Europe/London)",
    );
  });

  it("names the zone, because the same schedule means different things in two", () => {
    expect(
      describeCadence({ every: "day", hour: 9, minute: 0 }, NEW_YORK),
    ).toContain(NEW_YORK);
  });
});
