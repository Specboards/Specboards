import { ideaStageColors, statusColors } from "@specboards/ui";

import type { ReleaseStatus } from "@/lib/store/types";

/**
 * How a release's own status is named and coloured.
 *
 * A release moves through planned -> in progress -> shipped, which is a
 * different vocabulary from an item's workflow, but it should read the same way
 * on screen: a swatch paired with a label. Rather than mint a fourth palette,
 * each release status borrows the shared token for the state it means, so a
 * release in progress is the same amber as an item in progress and a shipped
 * release is the same green as done work. The dots stay decorative and
 * label-paired, as the token docs require.
 */
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

const RELEASE_STATUS_DOTS: Record<ReleaseStatus, string> = {
  planned: ideaStageColors.planned!.dot,
  in_progress: statusColors.in_progress!.dot,
  shipped: ideaStageColors.shipped!.dot,
};

/** Label for a release status, falling back to the raw key for anything unknown. */
export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABELS[status as ReleaseStatus] ?? status;
}

/** Decorative dot colour for a release status; grey for anything unknown. */
export function releaseStatusDotColor(status: string): string {
  return RELEASE_STATUS_DOTS[status as ReleaseStatus] ?? "#9ca3af";
}
