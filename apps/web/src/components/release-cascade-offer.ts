"use client";

import { toast } from "sonner";

import {
  getReleaseCascadePreview,
  patchFeature,
} from "@/lib/api-client/work-items";

/**
 * The offer to take an item's children along when it changes release.
 *
 * An offer, never a gate. The item's own change has already been saved by the
 * time this runs, which is what lets it work from the properties panel: that
 * panel autosaves on a debounce, and a modal in front of the write would be
 * arguing with a save the user did not ask to confirm in the first place.
 *
 * A toast for the same reason. Declining is dismissing it, which is one action
 * and asks nothing again for that change: the offer is made once per release
 * change, not re-raised on the next save of the same form.
 *
 * The counts come from the server. No client holds the whole subtree, so a
 * prompt that named a number here would be guessing, and the number is the
 * entire content of the question being asked.
 */
export function offerReleaseCascade({
  specId,
  releaseId,
  hasChildren = true,
  onApplied,
}: {
  specId: string;
  /** The release just set on the item, or null when it was cleared. */
  releaseId: string | null;
  /**
   * Whether the item has any children at all. A cheap local "no" that skips
   * the request entirely, which is the common case: most items are leaves.
   */
  hasChildren?: boolean;
  /** Re-read the board once children have actually moved. */
  onApplied?: () => void;
}): void {
  // Clearing a release cascades to nothing by design, so there is nothing to
  // ask about. See `@/lib/release-cascade`.
  if (releaseId === null || !hasChildren) return;

  void (async () => {
    let preview;
    try {
      preview = await getReleaseCascadePreview(specId, releaseId);
    } catch {
      // The item's own change landed. Failing to plan an optional extra is not
      // worth an error panel over a save that succeeded.
      return;
    }
    if (preview.moveCount === 0) return;

    const where = preview.releaseName ?? "this release";
    const items = preview.moveCount === 1 ? "1 child item" : `${preview.moveCount} child items`;
    toast(`Move ${items} to ${where} as well?`, {
      description: describeRest(preview),
      duration: 15_000,
      action: {
        label: "Move them",
        onClick: () => {
          void patchFeature(specId, { releaseId }, { cascadeRelease: true })
            .then(() => {
              toast.success(`Moved ${items} to ${where}`);
              onApplied?.();
            })
            .catch((err: unknown) => {
              toast.error(
                err instanceof Error ? err.message : "Could not move them.",
              );
            });
        },
      },
      cancel: { label: "No", onClick: () => {} },
    });
  })();
}

/**
 * The part of the offer that is about what will *not* move.
 *
 * Worth saying out loud. A cascade that quietly skipped somebody's deliberate
 * schedule would look identical to one that overwrote it, and the reader is
 * being asked to approve a write they cannot see.
 */
function describeRest(preview: {
  depth: number;
  skippedCount: number;
  ineligibleCount: number;
}): string | undefined {
  const parts: string[] = [];
  if (preview.depth > 1) parts.push(`Across ${preview.depth} levels.`);
  if (preview.skippedCount > 0) {
    parts.push(
      preview.skippedCount === 1
        ? "1 item already in another release stays where it is."
        : `${preview.skippedCount} items already in other releases stay where they are.`,
    );
  }
  if (preview.ineligibleCount > 0) {
    parts.push(
      preview.ineligibleCount === 1
        ? "1 item belongs to another product and cannot be moved here."
        : `${preview.ineligibleCount} items belong to other products and cannot be moved here.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
