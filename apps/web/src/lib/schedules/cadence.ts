/**
 * When a schedule next fires.
 *
 * ── Why not cron ────────────────────────────────────────────────────────────
 * Cron expressions are more expressive than anything this feature needs and
 * are read wrong by almost everybody: the difference between `0 9 * * 1` and
 * `9 0 * * 1` is a silent week of nothing happening. The people setting these
 * up are product teams describing "every Monday morning", so the model is that
 * sentence, and the UI can render it back as the sentence they typed. A cron
 * string can be added later as a second shape without changing the dispatcher,
 * because the dispatcher only reads `nextRunAt`.
 *
 * ── Why a timezone rather than UTC ──────────────────────────────────────────
 * A weekly digest set for Monday 09:00 has to arrive at 09:00 local in March
 * and in July. Storing the wall-clock time plus an IANA zone and resolving the
 * instant at each firing is the only arrangement that survives daylight saving;
 * storing a UTC instant and adding seven days drifts by an hour twice a year,
 * which is the kind of bug nobody reports and everybody notices.
 *
 * This module is pure and has no database, so "when does this fire next" is a
 * testable claim rather than something only observable by waiting.
 */

/** 0 is Sunday, matching `Date.prototype.getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Cadence =
  | { every: "day"; hour: number; minute: number }
  | { every: "week"; weekday: Weekday; hour: number; minute: number }
  /**
   * `day` is clamped to the length of the month, so 31 means "the last day"
   * in a 30-day month rather than skipping that month entirely. Skipping is
   * the other defensible answer and it is the worse one here: a monthly report
   * that silently misses February is a support ticket, and a report that
   * arrives on the 28th is a shrug.
   */
  | { every: "month"; day: number; hour: number; minute: number };

export class CadenceError extends Error {}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Read back out of `Intl` rather than from a table: the runtime already ships
 * the tz database and keeps it current, and a table of our own would be a
 * second source of truth that goes stale the next time a country moves its
 * clocks.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // `hour12: false` yields hour 24 for midnight in some runtimes; normalise.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/**
 * The instant at which the given wall-clock time occurs in `timeZone`.
 *
 * Two passes, because the offset depends on the instant and the instant
 * depends on the offset. The first guess uses the offset at the same
 * wall-clock reading in UTC, which is right except within an hour or two of a
 * transition; the second pass corrects it.
 *
 * ── The two times a year this is ambiguous ──────────────────────────────────
 * Spring forward deletes an hour of local time: 01:30 simply does not exist on
 * the changeover day in London. Both passes land outside the gap and the
 * result is the first real instant at or after the requested wall time, so a
 * 01:30 schedule fires at 02:00 that day rather than being skipped.
 *
 * Autumn repeats an hour: 01:30 happens twice. This resolves to the first of
 * the two, which is the earlier instant, so the schedule fires once rather
 * than twice and does so at the first opportunity.
 */
function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month, day, hour, minute, 0, 0);
  const firstGuess = new Date(naive - offsetMsAt(new Date(naive), timeZone));
  const corrected = new Date(naive - offsetMsAt(firstGuess, timeZone));
  return corrected;
}

/** The calendar date, in `timeZone`, that an instant falls on. */
function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")) - 1,
    day: Number(get("day")),
    weekday: Math.max(0, shortDays.indexOf(get("weekday"))) as Weekday,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Reject a zone the runtime does not know, before it is ever stored. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first firing strictly after `after`.
 *
 * Strictly after, never at, so that recording a run and computing the next one
 * from the same clock reading cannot return the instant that just fired and
 * loop. The dispatcher relies on this: it advances a schedule by asking for
 * the next occurrence after the one it just handled.
 */
export function nextOccurrence(
  cadence: Cadence,
  timeZone: string,
  after: Date,
): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new CadenceError(`Unknown time zone: ${timeZone}`);
  }
  assertValidCadence(cadence);

  const here = localParts(after, timeZone);

  // Walk forward a day at a time from the local date of `after`. Bounded, and
  // the bound is generous: a monthly cadence needs at most 31 steps from a
  // month boundary, and a day or week needs at most 8. Iterating candidate
  // local dates rather than adding fixed millisecond intervals is what keeps
  // this correct across a daylight-saving change, where "a day later" is 23 or
  // 25 hours.
  for (let step = 0; step <= 400; step++) {
    const probe = new Date(
      Date.UTC(here.year, here.month, here.day + step, 12, 0, 0),
    );
    const date = localParts(probe, timeZone);

    const matched = matchDay(cadence, date);
    if (matched === null) continue;

    const candidate = wallTimeToInstant(
      date.year,
      date.month,
      matched,
      cadence.hour,
      cadence.minute,
      timeZone,
    );
    if (candidate.getTime() > after.getTime()) return candidate;
  }

  // Unreachable for every cadence this module accepts. Thrown rather than
  // returning a far-future date, because a schedule that silently never fires
  // is the failure mode this feature exists to avoid.
  throw new CadenceError(
    "No firing found within 400 days, which should be impossible.",
  );
}

/**
 * The day-of-month this cadence wants on the probed date, or null if the date
 * is not a firing day at all.
 */
function matchDay(
  cadence: Cadence,
  date: { year: number; month: number; day: number; weekday: Weekday },
): number | null {
  if (cadence.every === "day") return date.day;
  if (cadence.every === "week") {
    return date.weekday === cadence.weekday ? date.day : null;
  }
  // Monthly: clamp to the month's length, so 31 lands on the 30th, or the 28th
  // or 29th in February, rather than skipping the month.
  const target = Math.min(cadence.day, daysInMonth(date.year, date.month));
  return date.day === target ? date.day : null;
}

function assertValidCadence(cadence: Cadence): void {
  const { hour, minute } = cadence;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new CadenceError("Hour must be a whole number from 0 to 23.");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new CadenceError("Minute must be a whole number from 0 to 59.");
  }
  if (cadence.every === "week") {
    if (!Number.isInteger(cadence.weekday) || cadence.weekday < 0 || cadence.weekday > 6) {
      throw new CadenceError("Weekday must be a whole number from 0 to 6.");
    }
  }
  if (cadence.every === "month") {
    if (!Number.isInteger(cadence.day) || cadence.day < 1 || cadence.day > 31) {
      throw new CadenceError("Day of month must be a whole number from 1 to 31.");
    }
  }
}

/** Parse a stored or submitted cadence, refusing anything malformed. */
export function parseCadence(raw: unknown): Cadence {
  if (typeof raw !== "object" || raw === null) {
    throw new CadenceError("A schedule needs a cadence.");
  }
  const o = raw as Record<string, unknown>;
  const hour = Number(o.hour);
  const minute = Number(o.minute ?? 0);

  let cadence: Cadence;
  switch (o.every) {
    case "day":
      cadence = { every: "day", hour, minute };
      break;
    case "week":
      cadence = {
        every: "week",
        weekday: Number(o.weekday) as Weekday,
        hour,
        minute,
      };
      break;
    case "month":
      cadence = { every: "month", day: Number(o.day), hour, minute };
      break;
    default:
      throw new CadenceError('Cadence "every" must be day, week or month.');
  }
  assertValidCadence(cadence);
  return cadence;
}

/**
 * The cadence as a sentence, for the settings list and for the notification
 * sent when a schedule fails.
 *
 * Here rather than in a component because the failure notification is written
 * by the dispatcher, which has no components, and two phrasings of the same
 * schedule would let the screen and the email disagree about what somebody set
 * up.
 */
export function describeCadence(cadence: Cadence, timeZone: string): string {
  const at = `${String(cadence.hour).padStart(2, "0")}:${String(cadence.minute).padStart(2, "0")}`;
  const zone = ` (${timeZone})`;
  if (cadence.every === "day") return `Every day at ${at}${zone}`;
  if (cadence.every === "week") {
    return `Every ${WEEKDAY_NAMES[cadence.weekday]} at ${at}${zone}`;
  }
  return `Monthly on day ${cadence.day} at ${at}${zone}`;
}
