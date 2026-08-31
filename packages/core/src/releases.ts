/**
 * The rule that decides a release's actual ship date.
 *
 * `shippedDate` answers "when did this ship", which is not the same question as
 * `targetDate` ("when did we say it would"). Both are kept, so a release can be
 * compared against its own plan after the fact.
 *
 * The rule lives here rather than in either store for the reason
 * `validateCycleDates` does: two implementations of one interface plus the
 * request parsers all have to reach the same answer, and the way they stopped
 * agreeing before was that only one of them knew the rule. The Postgres store
 * stamped on the status transition, the local store did the same, and neither
 * stamped on create, so a release created already shipped had no ship date at
 * all.
 *
 * Stated once, the rule is:
 *
 *   A release has a ship date if and only if it is shipped. If the caller named
 *   one, that is the date, and it may be in the past. Otherwise a release that
 *   has just shipped is stamped with today, and one that was already shipped
 *   keeps the date it already had.
 *
 * The "caller named one" case is what lets a release be recorded after the
 * fact, or a wrong date corrected later. Without it the only reachable ship
 * date is the day someone happened to press the button.
 */

/** A date-only string, the form every date in this product is stored in. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why an explicit ship date is not allowed here, or null when it is fine.
 *
 * `explicit` is `undefined` when the caller said nothing about the ship date,
 * which is always allowed: the date is then derived rather than given.
 *
 * Returns a message rather than throwing so that both stores and both request
 * parsers reject the same thing with the same wording, which is the same reason
 * `validateCycleDates` does.
 */
export function shippedDateError(
  explicit: string | null | undefined,
  shipped: boolean,
): string | null {
  if (explicit === undefined) return null;
  if (!shipped) {
    // Clearing it on something unshipped is a no-op rather than an error: the
    // value is already null, and refusing would make a patch that sets several
    // fields fail for the one that changes nothing.
    return explicit === null
      ? null
      : "Only a shipped release can have a ship date.";
  }
  if (explicit === null) {
    return "A shipped release must have a ship date.";
  }
  if (!DATE_ONLY.test(explicit)) {
    return "shippedDate must be a YYYY-MM-DD date.";
  }
  return null;
}

/**
 * The ship date a release should carry once this write lands.
 *
 * Total rather than a "leave it alone" signal: every input combination has one
 * correct answer, so the callers store what comes back instead of deciding for
 * themselves when the stamp applies. Call `shippedDateError` first.
 *
 * @param shipped  whether the release is shipped *after* this write
 * @param previous the ship date it carried before; null when creating
 * @param explicit a date named by the caller; undefined when none was
 * @param today    injected so the stores and their tests agree on "today"
 */
export function shippedDateAfterWrite({
  shipped,
  previous,
  explicit,
  today,
}: {
  shipped: boolean;
  previous: string | null;
  explicit?: string | null;
  today: string;
}): string | null {
  // Not shipped means no ship date, including on reopen: a release that is
  // planned again did not ship, whatever it used to say.
  if (!shipped) return null;
  // A named date wins, and may be historical. `shippedDateError` has already
  // rejected an explicit null here.
  if (explicit !== undefined && explicit !== null) return explicit;
  // Already shipped: keep the date it shipped on. An unrelated edit must not
  // move it to today.
  return previous ?? today;
}
