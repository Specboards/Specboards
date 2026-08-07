/**
 * The work scheduled into one release, shaped for the release detail flyout.
 *
 * The roadmap board only ever draws one hierarchy level at a time, so the
 * flyout is the only place a release's full contents are represented. It groups
 * them by level (Initiative, Epic, Feature, Work Item) in hierarchy order, top
 * level first, so the shape of the release reads at a glance.
 */

import type { WorkspaceLevel } from "@specboards/core";

/** One item scheduled into a release, as the flyout renders it. */
export interface ReleaseItem {
  specId: string;
  title: string;
  /** Hierarchy level key (see WorkspaceLevel). */
  level: string;
  status: string;
  /** Owning product, or null for legacy/unassigned rows. */
  productId: string | null;
}

/** One level's worth of a release's items, in hierarchy order. */
export interface ReleaseItemGroup {
  levelKey: string;
  /** Human label for the level ("Epic"); falls back to the raw key. */
  levelLabel: string;
  items: ReleaseItem[];
}

/**
 * Group a release's items by hierarchy level, top level first, dropping levels
 * the release holds nothing at.
 *
 * Items at a level the workspace no longer defines are not dropped: an admin
 * removing a level must not make work scheduled into a release invisible, so
 * those sort last under their raw key. Within a group, items are ordered by
 * title so the list is stable across reloads.
 */
export function groupReleaseItemsByLevel(
  items: ReleaseItem[],
  levels: WorkspaceLevel[],
): ReleaseItemGroup[] {
  const order = new Map(levels.map((l, i) => [l.key, i]));
  const labels = new Map(levels.map((l) => [l.key, l.label]));

  const byLevel = new Map<string, ReleaseItem[]>();
  for (const item of items) {
    const bucket = byLevel.get(item.level);
    if (bucket) bucket.push(item);
    else byLevel.set(item.level, [item]);
  }

  return [...byLevel.entries()]
    .sort(
      ([a], [b]) =>
        (order.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
    )
    .map(([levelKey, group]) => ({
      levelKey,
      levelLabel: labels.get(levelKey) ?? levelKey,
      items: [...group].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}
