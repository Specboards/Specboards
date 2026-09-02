import { descendantGroupIds, MAX_GROUP_DEPTH } from "@specboards/core";

import type { ProductGroupRecord, ProductRecord } from "@/lib/store/types";

/**
 * Reading the product tree: which groups sit under which, and which products
 * sit under those.
 *
 * These were closures inside `ProductsManager`, which meant the ordering rules
 * (position, then name, with a dangling parent falling back to the top level)
 * could only be exercised by rendering the page. They are functions of the
 * groups and products they are given and nothing else, so they belong here.
 *
 * Each takes the full list rather than a prepared index. That is the same cost
 * as before: the closures they replace also scanned the whole array on every
 * call, once per level of the tree.
 */

/**
 * A group flattened for tree display: depth-first, sibling position order.
 *
 * Not exported: it is the element type of what the two flatten helpers return,
 * and every caller reads it through them rather than naming it.
 */
interface TreeRow {
  group: ProductGroupRecord;
  depth: number;
}

/** Sibling order for both groups and products: position, then name to break ties. */
export function byPosition(
  a: { position: number; name: string },
  b: { position: number; name: string },
): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/**
 * A group's effective parent.
 *
 * A parent id that names no group in the list resolves to null, so a group
 * whose parent was deleted out from under it renders at the top level instead
 * of vanishing from the tree.
 */
export function effectiveParentId(
  groups: ProductGroupRecord[],
  group: ProductGroupRecord,
): string | null {
  if (!group.parentId) return null;
  return groups.some((g) => g.id === group.parentId) ? group.parentId : null;
}

/** A group's child groups in sibling order; `null` asks for the top level. */
export function childGroupsOf(
  groups: ProductGroupRecord[],
  parent: string | null,
): ProductGroupRecord[] {
  return groups
    .filter((g) => effectiveParentId(groups, g) === parent)
    .sort(byPosition);
}

/** The products filed under a group, in sibling order. */
export function productsOf(
  products: ProductRecord[],
  groupId: string,
): ProductRecord[] {
  return products.filter((p) => p.groupId === groupId).sort(byPosition);
}

/** The products in no group, in sibling order. */
export function ungroupedProducts(products: ProductRecord[]): ProductRecord[] {
  return products.filter((p) => !p.groupId).sort(byPosition);
}

/**
 * Flatten the group tree depth-first.
 *
 * A dangling parent (one naming no group in the list) renders at the top
 * level, so a group whose parent was deleted still appears. No group appears
 * twice, and a parent cycle terminates rather than recursing forever.
 *
 * A group in a pure cycle, reachable from no top-level row, is not emitted at
 * all. That is not a case this has to handle: the store refuses a parent change
 * that would create a cycle, so reaching it means the rows were written around
 * the API. The `seen` guard is here to bound the walk if that ever happens, not
 * to render its way out of it.
 */
export function flattenGroupTree(groups: ProductGroupRecord[]): TreeRow[] {
  const ids = new Set(groups.map((g) => g.id));
  const byParent = new Map<string | null, ProductGroupRecord[]>();
  for (const g of groups) {
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    const list = byParent.get(parent);
    if (list) list.push(g);
    else byParent.set(parent, [g]);
  }
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    const siblings = (byParent.get(parent) ?? []).sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    for (const g of siblings) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ group: g, depth });
      walk(g.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return out;
}

/** Parent choices for a group being created or moved: every group with room
 * below the depth cap, excluding (when editing) the group's own subtree. */
export function legalParentOptions(
  groups: ProductGroupRecord[],
  editing: ProductGroupRecord | null,
): TreeRow[] {
  const rows = flattenGroupTree(groups);
  if (!editing) return rows.filter((r) => r.depth + 1 < MAX_GROUP_DEPTH);
  const depthById = new Map(rows.map((r) => [r.group.id, r.depth]));
  const depth = depthById.get(editing.id) ?? 0;
  const subtree = descendantGroupIds(groups, editing.id);
  const subtreeHeight =
    Math.max(...[...subtree].map((id) => depthById.get(id) ?? depth)) -
    depth +
    1;
  return rows.filter(
    ({ group: candidate, depth: candidateDepth }) =>
      !subtree.has(candidate.id) &&
      candidateDepth + 1 + subtreeHeight <= MAX_GROUP_DEPTH,
  );
}
