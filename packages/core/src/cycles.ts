/**
 * Cycles (sprints / iterations): the date-bounded time box a team works in.
 *
 * A cycle is a second, orthogonal axis to releases, not a flavour of one. A
 * release is the ship vehicle and answers "what goes out together"; a cycle is
 * the time box and answers "what is the team working on right now". An item can
 * hold both, and clearing one never touches the other.
 *
 * The state of a cycle is **derived, never stored**. Anything persisted would
 * need something to keep it current: a cron, a login hook, or a write on read.
 * Computing it from the dates means a cycle is correct the instant the clock
 * passes its end date, with nothing running. This follows the same rule as the
 * RICE score, which is computed from its inputs so it cannot drift from them.
 */

/** Where a cycle sits relative to today. */
export type CycleState = "upcoming" | "active" | "complete";

export const CYCLE_STATES: readonly CycleState[] = [
  "upcoming",
  "active",
  "complete",
];

/** Display label for a cycle state. */
export function cycleStateLabel(state: CycleState): string {
  switch (state) {
    case "upcoming":
      return "Upcoming";
    case "active":
      return "Active";
    case "complete":
      return "Complete";
  }
}

/**
 * Today as a date-only `YYYY-MM-DD` string, in UTC. Shared by cycle state and
 * by release ship stamps, so the whole app agrees on which day it is. UTC
 * rather than the caller's zone deliberately: a cycle's state is computed on
 * the server and must not depend on which client asked.
 */
export function todayDateOnly(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A cycle's state, from its dates against `today` (both ends inclusive).
 * Date-only strings compare correctly with `<`/`>` in ISO form, so this needs
 * no Date parsing and no timezone reasoning: a cycle starts on its start date
 * wherever you are reading from.
 */
export function cycleState(
  cycle: { startDate: string; endDate: string },
  today: string = todayDateOnly(),
): CycleState {
  if (today < cycle.startDate) return "upcoming";
  if (today > cycle.endDate) return "complete";
  return "active";
}

/** True when the cycle contains `today` (both ends inclusive). */
export function isCycleActive(
  cycle: { startDate: string; endDate: string },
  today: string = todayDateOnly(),
): boolean {
  return cycleState(cycle, today) === "active";
}

/**
 * Whole days from `today` to the cycle's end, inclusive of today, or 0 once the
 * cycle is over. Drives the "3 days left" affordance on the cycle header.
 */
export function cycleDaysRemaining(
  cycle: { startDate: string; endDate: string },
  today: string = todayDateOnly(),
): number {
  if (today > cycle.endDate) return 0;
  const from = today < cycle.startDate ? cycle.startDate : today;
  const ms = Date.parse(`${cycle.endDate}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000) + 1);
}

/** Total length of the cycle in whole days, both ends inclusive. */
export function cycleLengthDays(cycle: {
  startDate: string;
  endDate: string;
}): number {
  const ms =
    Date.parse(`${cycle.endDate}T00:00:00Z`) -
    Date.parse(`${cycle.startDate}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/**
 * Order cycles for a picker or list: active first (that is where the work is),
 * then upcoming by soonest start, then complete by most recent end. Within a
 * group, ties break on name so the order is stable.
 */
export function compareCycles(
  a: { startDate: string; endDate: string; name: string },
  b: { startDate: string; endDate: string; name: string },
  today: string = todayDateOnly(),
): number {
  const rank: Record<CycleState, number> = {
    active: 0,
    upcoming: 1,
    complete: 2,
  };
  const aState = cycleState(a, today);
  const bState = cycleState(b, today);
  if (rank[aState] !== rank[bState]) return rank[aState] - rank[bState];
  if (aState === "complete") {
    // Most recently finished first: a completed cycle's relevance decays.
    if (a.endDate !== b.endDate) return a.endDate < b.endDate ? 1 : -1;
  } else if (a.startDate !== b.startDate) {
    return a.startDate < b.startDate ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * The cycles a scheduling picker should offer: everything that has not already
 * finished, plus `keepId` (the item's current cycle) even when it has, so an
 * item already in a finished cycle keeps showing its real value rather than
 * appearing unscheduled. Mirrors `selectableReleases`.
 */
export function selectableCycles<T extends { id: string; startDate: string; endDate: string }>(
  cycles: T[],
  keepId: string | null,
  today: string = todayDateOnly(),
): T[] {
  return cycles.filter(
    (c) => cycleState(c, today) !== "complete" || c.id === keepId,
  );
}

/** The cycles a single product should see: its own plus workspace-wide ones,
 * which apply everywhere. Mirrors `releasesForProduct`. */
export function cyclesForProduct<T extends { productId: string | null }>(
  cycles: T[],
  productId: string | null,
): T[] {
  return cycles.filter(
    (c) => c.productId === null || c.productId === productId,
  );
}

/** Raised when a cycle's dates are unusable. Returns the message rather than
 * throwing so both stores and the parser can share one wording. */
export function validateCycleDates(
  startDate: string,
  endDate: string,
): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(startDate)) return "startDate must be a YYYY-MM-DD date.";
  if (!iso.test(endDate)) return "endDate must be a YYYY-MM-DD date.";
  if (endDate < startDate) return "A cycle cannot end before it starts.";
  return null;
}

// ── Schedule generation ───────────────────────────────────────────────────
// A team running fixed-length sprints should not hand-create twenty of them.
// Given a start, a cadence and a horizon, this works out every cycle in the
// run and names them in sequence.
//
// The generation is pure and lives here, next to the rest of the date logic,
// for the same reason `validateCycleDates` does: both stores and the UI need
// the identical answer. The UI in particular calls it to preview exactly what
// a generate would create, so a preview can never disagree with the result.

/** The token in a name template that carries the sequence number. */
export const CYCLE_NUMBER_TOKEN = "{n}";

/**
 * Upper bound on a single generate. Guards against a slip like a one-day
 * cadence over five years quietly inserting two thousand rows. Chosen to be far
 * beyond any real cadence (weekly for four years is 208) so it only ever fires
 * on a mistake.
 */
export const MAX_GENERATED_CYCLES = 200;

/** What to generate: a cadence, a horizon, and how to name the results. */
export interface CycleScheduleInput {
  /** Inclusive first day of the first cycle (YYYY-MM-DD). */
  startDate: string;
  /** Inclusive horizon (YYYY-MM-DD). No generated cycle ends after this. */
  endDate: string;
  /** Length of each cycle in whole days, both ends inclusive (14 = a fortnight). */
  lengthDays: number;
  /** Name template containing `{n}`, e.g. "Sprint {n}". */
  nameTemplate: string;
  /** Sequence number the first generated cycle takes. */
  startNumber: number;
}

/** One cycle the generator intends to create. Not yet persisted. */
export interface PlannedCycle {
  name: string;
  startDate: string;
  endDate: string;
}

/** A date-only string `n` days after `date`. Stays in UTC, matching the rest
 * of this module, so no local timezone can shift a cycle boundary by a day. */
export function addDaysDateOnly(date: string, n: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate a generate request, returning the message or null. Shared by the
 * stores and the request parser so one wording covers every entry point.
 */
export function validateCycleScheduleInput(
  input: CycleScheduleInput,
): string | null {
  const dateError = validateCycleDates(input.startDate, input.endDate);
  if (dateError) return dateError;
  if (!Number.isInteger(input.lengthDays) || input.lengthDays < 1) {
    return "lengthDays must be a whole number of days, at least 1.";
  }
  if (!Number.isInteger(input.startNumber) || input.startNumber < 0) {
    return "startNumber must be a whole number, at least 0.";
  }
  if (!input.nameTemplate.trim()) {
    return "A name template is required.";
  }
  if (!input.nameTemplate.includes(CYCLE_NUMBER_TOKEN)) {
    return `The name template must contain ${CYCLE_NUMBER_TOKEN}, so each cycle gets a distinct name.`;
  }
  // A cadence longer than the horizon yields nothing at all. Say so here
  // rather than letting the caller create zero cycles and wonder why.
  if (addDaysDateOnly(input.startDate, input.lengthDays - 1) > input.endDate) {
    return "The first cycle would end after the end date. Shorten the cycle length or extend the end date.";
  }
  if (countCycleSchedule(input) > MAX_GENERATED_CYCLES) {
    return `That would create more than ${MAX_GENERATED_CYCLES} cycles. Shorten the date range or lengthen the cycle.`;
  }
  return null;
}

/**
 * How many whole cycles fit, computed arithmetically rather than by walking the
 * loop. `validateCycleScheduleInput` needs the count *before* it is willing to
 * generate, so this must not itself be bounded by the cap it is checking.
 */
function countCycleSchedule(input: CycleScheduleInput): number {
  const spanMs =
    Date.parse(`${input.endDate}T00:00:00Z`) -
    Date.parse(`${input.startDate}T00:00:00Z`);
  const spanDays = Math.round(spanMs / 86_400_000) + 1;
  return Math.max(0, Math.floor(spanDays / input.lengthDays));
}

/**
 * Every cycle in the run, back to back, named in sequence.
 *
 * Cycles abut rather than overlap: each starts the day after the previous one
 * ends, matching how `cycleLengthDays` counts (both ends inclusive), so a
 * fortnightly cadence from the 10th runs 10th-23rd, then 24th-6th.
 *
 * Only **whole** cycles are generated. A trailing remainder shorter than the
 * cadence is left uncovered rather than emitted as a stunted final cycle, which
 * is almost never what a team running fixed-length sprints wants. Callers that
 * want to tell the user about the gap can use `cycleScheduleRemainderDays`.
 *
 * Returns an empty array when the input is unusable; validate first if you want
 * to know why.
 */
export function generateCycleSchedule(
  input: CycleScheduleInput,
): PlannedCycle[] {
  if (validateCycleScheduleInput(input)) return [];
  const planned: PlannedCycle[] = [];
  let cursor = input.startDate;
  let number = input.startNumber;
  while (planned.length < MAX_GENERATED_CYCLES) {
    const end = addDaysDateOnly(cursor, input.lengthDays - 1);
    if (end > input.endDate) break;
    planned.push({
      name: input.nameTemplate.replaceAll(
        CYCLE_NUMBER_TOKEN,
        String(number),
      ),
      startDate: cursor,
      endDate: end,
    });
    cursor = addDaysDateOnly(end, 1);
    number += 1;
  }
  return planned;
}

/**
 * Days between the last generated cycle's end and the requested end date, which
 * the cadence could not fill. Zero when the run divides evenly. Surfaced in the
 * preview so nobody is surprised that "until the end of the year" stopped on
 * the 18th of December.
 */
export function cycleScheduleRemainderDays(input: CycleScheduleInput): number {
  const planned = generateCycleSchedule(input);
  const last = planned[planned.length - 1];
  if (!last) return 0;
  const ms =
    Date.parse(`${input.endDate}T00:00:00Z`) -
    Date.parse(`${last.endDate}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * The number a new run should start at, from the names already in use: one past
 * the highest that matches the template. So a workspace with "Sprint 1" through
 * "Sprint 5" continues at 6 rather than colliding, which is the common case
 * when a team hand-created the first few and now wants the rest of the year.
 *
 * Returns 1 when nothing matches, since teams number sprints from one.
 */
export function nextCycleNumber(
  existingNames: readonly string[],
  nameTemplate: string,
): number {
  if (!nameTemplate.includes(CYCLE_NUMBER_TOKEN)) return 1;
  // Escape the literal parts so a template like "Q3 (n)" cannot smuggle in
  // regex syntax, then let the token stand for the digits.
  const pattern = nameTemplate
    .split(CYCLE_NUMBER_TOKEN)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(\\d+)");
  const re = new RegExp(`^${pattern}$`);
  let highest = 0;
  for (const name of existingNames) {
    const match = re.exec(name.trim());
    if (!match) continue;
    // Every capture comes from the same token, so any of them will do.
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest + 1;
}
