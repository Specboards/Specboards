/**
 * Row ordering for the backlog list view. The table shows one hierarchy level
 * at a time (the `?level=` param the board also uses): items at the active
 * level are the top-level rows, each followed by its direct children from the
 * level immediately below. Grouping therefore only appears where the active
 * level has a level under it to group.
 */

/** The shape the row builder needs; `FeatureRecord` satisfies it. */
export interface LevelledItem {
  specId: string;
  level: string;
  parentSpecId: string | null;
}

export interface LevelRow<T> {
  feature: T;
  depth: number;
}

/**
 * Order rows for one hierarchy level: every item at `levelKey` at depth 0,
 * each followed by its children at `childKey` (depth 1). Input order is
 * preserved within both tiers, so an already-sorted list stays sorted.
 *
 * Items at the child level whose parent is absent (an orphan, or a parent
 * hidden by the shipped filter) are not shown here — they are reachable by
 * switching to their own level, where they become top-level rows.
 */
export function buildLevelRows<T extends LevelledItem>(
  items: readonly T[],
  levelKey: string,
  childKey: string | null,
): LevelRow<T>[] {
  const childrenOf = new Map<string, T[]>();
  if (childKey) {
    for (const item of items) {
      if (item.level !== childKey || !item.parentSpecId) continue;
      const siblings = childrenOf.get(item.parentSpecId) ?? [];
      siblings.push(item);
      childrenOf.set(item.parentSpecId, siblings);
    }
  }

  const rows: LevelRow<T>[] = [];
  for (const item of items) {
    if (item.level !== levelKey) continue;
    rows.push({ feature: item, depth: 0 });
    for (const child of childrenOf.get(item.specId) ?? [])
      rows.push({ feature: child, depth: 1 });
  }
  return rows;
}
