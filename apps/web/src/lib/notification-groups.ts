import type { NotificationRecord } from "@/lib/store/types";

/**
 * Ten changes to one item, read as one block.
 *
 * Grouping happens here, at read time, rather than by de-duplicating a burst of
 * events when they are raised. That was the decision on the epic and it holds
 * up for a reason worth keeping: a notification is a record of something that
 * happened, and collapsing two of them at write time destroys the fact that
 * there were two. Grouping on the way out is reversible, costs one pass, and
 * lets the same rows read as a list or as blocks depending on the surface.
 *
 * Grouped by item, not by type. The question a reader brings to the inbox is
 * "what happened to the things I work on", so an item that moved stage, picked
 * up a comment and was reassigned is one thing to catch up on, not three.
 *
 * Only within the page that was loaded. A group cannot span a pagination
 * boundary without asking the database to group, and a block that silently grew
 * when somebody scrolled would be worse than two blocks for the same item.
 */
interface NotificationGroup {
  /** The item every row in this group is about. */
  specId: string;
  featureTitle: string;
  featureLevel: string;
  productSlug: string;
  /** Newest first, matching the order they arrived in. */
  items: NotificationRecord[];
  /** How many in this group the reader has not read. */
  unreadCount: number;
  /** The newest row's timestamp, which is what the group is ordered by. */
  newestAt: string;
}

export function groupNotifications(
  items: readonly NotificationRecord[],
): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  // Input is already newest first, so the first row seen for an item is its
  // newest and fixes the group's position. Insertion order is therefore the
  // right order, and no sort is needed (a sort would also have to be stable to
  // keep two groups with the same timestamp from swapping between renders).
  for (const item of items) {
    const existing = groups.get(item.specId);
    if (existing) {
      existing.items.push(item);
      if (!item.read) existing.unreadCount += 1;
      continue;
    }
    groups.set(item.specId, {
      specId: item.specId,
      featureTitle: item.featureTitle,
      featureLevel: item.featureLevel,
      productSlug: item.productSlug,
      items: [item],
      unreadCount: item.read ? 0 : 1,
      newestAt: item.createdAt,
    });
  }
  return [...groups.values()];
}
