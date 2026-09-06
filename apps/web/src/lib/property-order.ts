import type { PropertyDef } from "@specboards/core";

/** A position write a reorder needs: patch `id` to `position`. */
interface PositionWrite {
  id: string;
  position: number;
}

/**
 * The writes that move one custom property one place within its own ordering.
 *
 * Two things make this less obvious than a swap of two `position` values.
 *
 * Positions are scoped per entity (see the store's `createProperty`), so an
 * item property's neighbour is the next *item* property, not whatever renders
 * beside it in a settings list that also holds release properties.
 *
 * And `position` defaults to 0, so a workspace whose properties predate the
 * column can have every row sitting at 0 and ordered by `created_at` behind
 * it. Swapping two zeroes is a visible no-op. So the entity group is renumbered
 * to ordinals instead: that repairs a legacy all-zero list on first use, and
 * costs nothing afterwards because only rows whose position actually changes
 * are returned.
 *
 * Returns an empty list when the move is not possible (the property is unknown,
 * or it is already at the end it is being moved towards).
 */
export function reorderProperty(
  properties: PropertyDef[],
  propertyId: string,
  delta: -1 | 1,
): PositionWrite[] {
  const subject = properties.find((p) => p.id === propertyId);
  if (!subject) return [];
  const peers = properties.filter((p) => p.entity === subject.entity);
  const from = peers.findIndex((p) => p.id === propertyId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= peers.length) return [];

  const next = [...peers];
  const [moved] = next.splice(from, 1);
  if (!moved) return [];
  next.splice(to, 0, moved);

  return next.flatMap((p, index) =>
    p.position === index ? [] : [{ id: p.id, position: index }],
  );
}
