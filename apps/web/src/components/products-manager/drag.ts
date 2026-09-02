import { wouldCreateCycle, wouldExceedDepth } from "@specboards/core";

import type { ProductGroupPatch, ProductGroupRecord } from "@/lib/store/types";

import { childGroupsOf, effectiveParentId } from "./tree";

/**
 * What a drop means, decided without a DOM.
 *
 * Dragging a group is the one operation on this screen with real arithmetic in
 * it: a drop slot's index counts the dragged row itself when that row already
 * sits among the target siblings, so a raw index moves a row one place short of
 * where the bar showed it. That compensation, the sibling renumbering it
 * forces, and the cycle and depth refusals all lived inside a component method
 * that could only be reached by driving dnd-kit. They are decisions about
 * arrays, so they are made here and the component applies the answer.
 *
 * What deliberately stays in the component: the toast copy for a refusal, the
 * optimistic write, and the rollback. This module decides, it does not act.
 */

/** Split a "kind:rest" drag/drop id into its kind and payload. */
export function parseDndId(raw: string): { kind: string; rest: string } {
  const i = raw.indexOf(":");
  return { kind: raw.slice(0, i), rest: raw.slice(i + 1) };
}

/** Where a drop lands: a destination group (null for the top level), and the
 * slot to insert at when the drop was on a reorder bar rather than a row. */
interface DropTarget {
  intoGroup: string | null;
  slotIndex: number | null;
}

/**
 * Resolve the id of whatever was dropped on into a destination.
 *
 * Returns null for anything that is not a destination, which is how a drop on
 * another draggable row (rather than a group or a slot) is ignored.
 */
export function resolveDropTarget(overId: string): DropTarget | null {
  const target = parseDndId(overId);
  if (target.kind === "into") {
    return { intoGroup: target.rest, slotIndex: null };
  }
  if (target.kind === "slot") {
    // The parent id comes first and may itself contain a colon, so the index
    // is split off the end rather than the front.
    const cut = target.rest.lastIndexOf(":");
    const parent = target.rest.slice(0, cut);
    return {
      intoGroup: parent === "root" ? null : parent,
      slotIndex: Number(target.rest.slice(cut + 1)),
    };
  }
  if (target.kind === "ungrouped") {
    return { intoGroup: null, slotIndex: null };
  }
  return null;
}

/** Why a move was refused. The component owns what each one says to the user. */
export type GroupMoveRefusal = "self" | "cycle" | "depth";

type GroupMovePlan =
  | { ok: false; reason: GroupMoveRefusal }
  /**
   * `patches` is what to persist and `groups` is the state to show while it is
   * in flight. An empty `patches` means the move was legal but changes nothing,
   * and the caller should do neither.
   */
  | {
      ok: true;
      patches: { id: string; patch: ProductGroupPatch }[];
      groups: ProductGroupRecord[];
    };

/**
 * Work out how to move `draggedId` under `newParent`, inserted at
 * `insertIndex` among its new siblings (null to append).
 *
 * `position` is an integer column, so inserting between two rows is not a
 * single write: the whole destination sibling list is renumbered 0..n and only
 * the rows whose number actually changed are patched.
 *
 * `insertIndex` is clamped into the sibling range. The component only ever
 * passes an index in range, but this is a function anyone can now call, and
 * an out-of-range index would otherwise slice the sibling list into nonsense.
 */
export function planGroupMove(
  groups: ProductGroupRecord[],
  draggedId: string,
  newParent: string | null,
  insertIndex: number | null,
): GroupMovePlan {
  const dragged = groups.find((g) => g.id === draggedId);
  if (!dragged || newParent === draggedId) return { ok: false, reason: "self" };
  if (wouldCreateCycle(groups, draggedId, newParent)) {
    return { ok: false, reason: "cycle" };
  }
  if (wouldExceedDepth(groups, draggedId, newParent)) {
    return { ok: false, reason: "depth" };
  }

  const oldParent = effectiveParentId(groups, dragged);
  // Slot indexes count the dragged row itself when it already sits among the
  // target siblings; compensate so the drop lands where the bar showed.
  let index = insertIndex;
  if (index !== null && oldParent === newParent) {
    const orig = childGroupsOf(groups, newParent).findIndex(
      (g) => g.id === draggedId,
    );
    if (orig >= 0 && orig < index) index -= 1;
  }
  const siblings = childGroupsOf(groups, newParent).filter(
    (g) => g.id !== draggedId,
  );
  const at =
    index === null
      ? siblings.length
      : Math.max(0, Math.min(index, siblings.length));
  const order = [...siblings.slice(0, at), dragged, ...siblings.slice(at)];

  const patches: { id: string; patch: ProductGroupPatch }[] = [];
  order.forEach((g, i) => {
    const patch: ProductGroupPatch = {};
    if (g.position !== i) patch.position = i;
    if (g.id === draggedId && oldParent !== newParent) {
      patch.parentId = newParent;
    }
    if (Object.keys(patch).length > 0) patches.push({ id: g.id, patch });
  });

  const posById = new Map(order.map((g, i) => [g.id, i]));
  return {
    ok: true,
    patches,
    groups: groups.map((g) => ({
      ...g,
      position: posById.get(g.id) ?? g.position,
      parentId: g.id === draggedId ? newParent : g.parentId,
    })),
  };
}
