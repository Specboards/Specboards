/**
 * Product groups: management-level nodes that collect products (and other
 * groups) into parts of a platform so content can be rolled up. This module is
 * the framework-agnostic shape + pure tree helpers; rows live in the
 * `product_groups` table and visibility rules follow `permissions` (group
 * metadata is member-visible; aggregates only count readable products).
 */

export interface ProductGroup {
  id: string;
  /** Stable slug used as the `~{key}` scope segment in product-slot URLs. */
  key: string;
  name: string;
  description: string | null;
  /** Accent color token (see `PRODUCT_COLORS`), or null. */
  color: string | null;
  /** Parent group id for nesting; null = top-level. */
  parentId: string | null;
  /** Manual sibling ordering; ascending. */
  position: number;
}

/** Maximum nesting depth of the group tree (a top-level group has depth 1). */
export const MAX_GROUP_DEPTH = 4;

const KEY_MAX = 48;

/**
 * Derive a stable group key from a name, unique against `taken`. Mirrors
 * `productKeyFromName` so `~{key}` URLs stay readable. Keys share the
 * `[a-z0-9-]` alphabet with product keys; the `~` prefix in URLs is what
 * disambiguates a group scope from a product scope.
 */
export function groupKeyFromName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, KEY_MAX) || "group";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  return key;
}

type GroupNode = Pick<ProductGroup, "id" | "parentId">;

/** Map of group id -> its direct children, for one walk over `groups`. */
function childrenByParent(groups: readonly GroupNode[]): Map<string, GroupNode[]> {
  const map = new Map<string, GroupNode[]>();
  for (const g of groups) {
    if (!g.parentId) continue;
    const list = map.get(g.parentId);
    if (list) list.push(g);
    else map.set(g.parentId, [g]);
  }
  return map;
}

/**
 * Ids of `groupId` plus every descendant group, walking the tree downward.
 * Robust to cycles (each id is visited once), so a corrupt tree degrades to a
 * partial set rather than an infinite loop.
 */
export function descendantGroupIds(
  groups: readonly GroupNode[],
  groupId: string,
): Set<string> {
  const byParent = childrenByParent(groups);
  const seen = new Set<string>([groupId]);
  const queue = [groupId];
  while (queue.length) {
    const id = queue.pop()!;
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
    }
  }
  return seen;
}

/**
 * Depth of `groupId` counting itself and its ancestors (top-level = 1).
 * Cycle-safe: stops when an ancestor repeats.
 */
export function groupDepth(groups: readonly GroupNode[], groupId: string): number {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  let depth = 0;
  let current: GroupNode | undefined = byId.get(groupId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    depth++;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return depth;
}

/** Height of the subtree rooted at `groupId` (a leaf group = 1). */
function subtreeHeight(groups: readonly GroupNode[], groupId: string): number {
  const byParent = childrenByParent(groups);
  const seen = new Set<string>();
  const walk = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let max = 0;
    for (const child of byParent.get(id) ?? []) max = Math.max(max, walk(child.id));
    return 1 + max;
  };
  return walk(groupId);
}

/**
 * Would setting `groupId`'s parent to `newParentId` create a cycle? True when
 * the proposed parent is the group itself or lives in its subtree.
 */
export function wouldCreateCycle(
  groups: readonly GroupNode[],
  groupId: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  return descendantGroupIds(groups, groupId).has(newParentId);
}

/**
 * Would setting `groupId`'s parent to `newParentId` push any group in its
 * subtree past `MAX_GROUP_DEPTH`? (`groups` should reflect the tree BEFORE the
 * move; the group itself may be absent when it is being created.)
 */
export function wouldExceedDepth(
  groups: readonly GroupNode[],
  groupId: string,
  newParentId: string | null,
): boolean {
  const parentDepth = newParentId ? groupDepth(groups, newParentId) : 0;
  const exists = groups.some((g) => g.id === groupId);
  const height = exists ? subtreeHeight(groups, groupId) : 1;
  return parentDepth + height > MAX_GROUP_DEPTH;
}
