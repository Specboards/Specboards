import type { AxisScale } from "@/lib/roadmap-timeline";

/**
 * On-screen measurements shared by the release timeline and the laddered
 * portfolio timeline. Kept in one place because both views draw on the same axis
 * and the ladder positions its dependency overlay in pixels: a gutter width that
 * disagreed with the layout would offset every edge.
 */

/**
 * Minimum width of one column, per scale. A week needs less room than "Jul 26"
 * does, and a quarter label sits on three months of bar.
 */
export const COLUMN_PX: Record<AxisScale, number> = {
  week: 60,
  month: 116,
  quarter: 132,
};

/** Minimum width of the whole track, so a single-column axis still reads as a time axis. */
export const MIN_TRACK_PX = 640;

/** Left gutter (row labels) width in px. */
export const GUTTER_PX = 224;

/** The same width as a class, for layouts that do not need the number. */
export const GUTTER_CLASS = "w-56 shrink-0";
