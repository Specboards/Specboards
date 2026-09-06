import type { ReleaseRecord } from "@/lib/store/types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Format an ISO `YYYY-MM-DD` date value as a short human date (e.g. "Jul 24,
 * 2026"). Non-ISO input is returned unchanged.
 *
 * Assembled from the calendar parts rather than formatted by `Intl`, for two
 * reasons. A date-only value has no instant, so `new Date(string)` would let
 * it shift a day across a timezone. And these render on the server before they
 * render in the browser: `toLocaleDateString(undefined, …)` reads the locale of
 * whoever runs it, so a server on `en-US` and a viewer on `en-GB` produce
 * "Jul 24, 2026" and "24 Jul 2026" from the same value. React treats that
 * disagreement as a corrupted tree and never attaches the page's event
 * handlers, which turns a formatting difference into a board where nothing is
 * clickable. Fixed English output cannot disagree with itself.
 *
 * A month outside 1-12 is returned unchanged rather than silently rolled over,
 * which is what `new Date(2026, 12, 1)` would have done to "2026-13-01".
 */
export function formatIsoDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return value;
  return `${month} ${day}, ${m[1]}`;
}

/**
 * When the work in a release ships, as a phrase to sit beside the release name
 * on an item: "Shipped Sep 2, 2026", "Ships Sep 3, 2026", or null.
 *
 * An item's ship date is its release's ship date. It is deliberately derived
 * rather than stored on the item, and that is the whole design of this:
 *
 * - A built-in date field on every card would be a second, hand-maintained
 *   copy of a date the release already owns. It starts correct and drifts the
 *   first time a release slips, and then nothing says which of the two wins.
 * - Binding it to an admin-configured custom property would make the answer
 *   depend on settings, so the same card in two products would answer the same
 *   question differently.
 *
 * `shippedDate` wins over `targetDate` because it is a fact rather than a
 * commitment, and it is the presence of the date rather than the release's
 * status that decides: the date is what was actually stamped. Undated releases
 * return null instead of a "no date" chip, for the same reason the relations
 * list does not badge unscheduled items - spending a line to say the reader
 * already knows is worse than silence.
 *
 * The two verbs carry the difference in confidence. There is deliberately no
 * "overdue" treatment for a target date now in the past: knowing that needs a
 * notion of today, and a clock read independently on the server and in the
 * browser is exactly the hydration hazard `formatIsoDate` exists to avoid. It
 * needs a server-provided date threaded down, which is its own change.
 */
export function shipDateLabel(
  release: Pick<ReleaseRecord, "targetDate" | "shippedDate">,
): string | null {
  if (release.shippedDate) return `Shipped ${formatIsoDate(release.shippedDate)}`;
  if (release.targetDate) return `Ships ${formatIsoDate(release.targetDate)}`;
  return null;
}
