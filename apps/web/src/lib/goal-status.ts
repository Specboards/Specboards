import { ideaStageColors, statusColors } from "@specboards/ui";

import {
  goalStatusLabel as coreGoalStatusLabel,
  isGoalStatus,
  type GoalStatus,
} from "@/lib/store/types";

/**
 * How a goal's status is named and coloured.
 *
 * A goal status is a judgement, not a stage: the owner's call on how it is
 * going, deliberately separate from either computed progress figure. It still
 * reads like every other state in the app (a swatch paired with a label), and
 * like release status it borrows the shared tokens rather than minting a
 * palette: at risk is the same amber as work in progress, achieved the same
 * green as done.
 *
 * Lives here, beside `release-status.ts`, so the Goals page, the portfolio
 * dashboard, and the timeline swimlane cannot drift into three tones for the
 * same judgement.
 */

/** Text tone per status, from the shared semantic tokens. */
const GOAL_STATUS_TONE: Record<GoalStatus, string> = {
  on_track: "text-[var(--success)]",
  at_risk: "text-[var(--warning)]",
  off_track: "text-destructive",
  achieved: "text-[var(--success)]",
  missed: "text-muted-foreground",
};

const GOAL_STATUS_DOTS: Record<GoalStatus, string> = {
  on_track: statusColors.done!.dot,
  at_risk: statusColors.in_progress!.dot,
  off_track: ideaStageColors.declined!.dot,
  achieved: ideaStageColors.shipped!.dot,
  missed: ideaStageColors.parked!.dot,
};

/**
 * Label for a goal status, falling back to the raw key for anything unknown.
 *
 * The tolerant twin of core's exhaustive `goalStatusLabel`: views that carry a
 * status as a plain string (the timeline model, which needs no goal vocabulary
 * of its own) call this rather than casting.
 */
export function goalStatusLabel(status: string): string {
  return isGoalStatus(status) ? coreGoalStatusLabel(status) : status;
}

/** Text tone for a goal status; muted for anything unknown. */
export function goalStatusTone(status: string): string {
  return GOAL_STATUS_TONE[status as GoalStatus] ?? "text-muted-foreground";
}

/** Decorative dot/fill colour for a goal status; grey for anything unknown. */
export function goalStatusDotColor(status: string): string {
  return GOAL_STATUS_DOTS[status as GoalStatus] ?? "#9ca3af";
}
