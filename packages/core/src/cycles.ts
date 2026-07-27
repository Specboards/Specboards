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
