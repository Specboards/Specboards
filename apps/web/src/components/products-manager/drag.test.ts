import { describe, expect, it } from "vitest";

import type { ProductGroupRecord } from "@/lib/store/types";

import { parseDndId, planGroupMove, resolveDropTarget } from "./drag";

/**
 * The arithmetic behind dragging a group.
 *
 * Worth testing rather than reading because the two things most likely to be
 * wrong are invisible in the JSX: whether a slot index means what the drop bar
 * showed, and whether the sibling renumbering that an integer `position`
 * column forces touches only the rows that actually moved. Until this was
 * extracted neither could be checked without driving dnd-kit.
 */

function group(
  id: string,
  position: number,
  parentId: string | null = null,
  name = id,
): ProductGroupRecord {
  return { id, name, parentId, position } as ProductGroupRecord;
}

/** a(0), b(1), c(2) at the top level. */
const flat = [group("a", 0), group("b", 1), group("c", 2)];

describe("parseDndId", () => {
  it("splits on the first colon, so the payload may contain more", () => {
    expect(parseDndId("slot:root:2")).toEqual({ kind: "slot", rest: "root:2" });
  });
});

describe("resolveDropTarget", () => {
  it("reads a drop on a group as a move into it", () => {
    expect(resolveDropTarget("into:g1")).toEqual({
      intoGroup: "g1",
      slotIndex: null,
    });
  });

  it("reads a top-level slot as the top level at that index", () => {
    expect(resolveDropTarget("slot:root:2")).toEqual({
      intoGroup: null,
      slotIndex: 2,
    });
  });

  it("splits a slot's index off the end, not its parent off the front", () => {
    // The parent is an id, and an id is not guaranteed to be colon-free. Taking
    // the first colon here would read the parent as "g1" and the index as NaN.
    expect(resolveDropTarget("slot:g1:extra:3")).toEqual({
      intoGroup: "g1:extra",
      slotIndex: 3,
    });
  });

  it("reads the ungrouped zone as the top level with no slot", () => {
    expect(resolveDropTarget("ungrouped:zone")).toEqual({
      intoGroup: null,
      slotIndex: null,
    });
  });

  it("ignores a drop on anything that is not a destination", () => {
    expect(resolveDropTarget("product:p1")).toBeNull();
    expect(resolveDropTarget("group:g1")).toBeNull();
  });
});

describe("planGroupMove", () => {
  it("refuses to move a group into itself", () => {
    expect(planGroupMove(flat, "a", "a", null)).toEqual({
      ok: false,
      reason: "self",
    });
  });

  it("refuses a move into the group's own subtree", () => {
    const nested = [group("a", 0), group("b", 0, "a")];
    expect(planGroupMove(nested, "a", "b", null)).toEqual({
      ok: false,
      reason: "cycle",
    });
  });

  it("plans nothing when the move changes no position or parent", () => {
    // Legal, but a no-op: the caller must not write or paint an optimistic
    // state for this, which is why it is an empty patch list rather than a
    // refusal.
    const plan = planGroupMove(flat, "a", null, 0);
    expect(plan.ok && plan.patches).toEqual([]);
  });

  it("compensates for the dragged row when moving down among its siblings", () => {
    // The bar below c is slot 3, and a is still counted in that numbering.
    // Without the compensation a would land at index 3 of a 2-item list and
    // stop one place short, between b and c.
    const plan = planGroupMove(flat, "a", null, 3);
    expect(plan.ok && plan.patches).toEqual([
      { id: "b", patch: { position: 0 } },
      { id: "c", patch: { position: 1 } },
      { id: "a", patch: { position: 2 } },
    ]);
  });

  it("does not compensate when moving up, where the index already fits", () => {
    const plan = planGroupMove(flat, "c", null, 0);
    expect(plan.ok && plan.patches).toEqual([
      { id: "c", patch: { position: 0 } },
      { id: "a", patch: { position: 1 } },
      { id: "b", patch: { position: 2 } },
    ]);
  });

  it("matches what the Move menu's down action asks for", () => {
    // The menu passes index + 2 for "down" precisely because of the
    // compensation above. Moving b (index 1) down must put it after c.
    const plan = planGroupMove(flat, "b", null, 3);
    expect(plan.ok && plan.groups.map((g) => [g.id, g.position])).toEqual([
      ["a", 0],
      ["b", 2],
      ["c", 1],
    ]);
  });

  it("renumbers the destination and reparents when the parent changes", () => {
    const groups = [group("p", 0), group("a", 0, "p"), group("x", 5)];
    const plan = planGroupMove(groups, "x", "p", 0);
    expect(plan.ok && plan.patches).toEqual([
      { id: "x", patch: { position: 0, parentId: "p" } },
      { id: "a", patch: { position: 1 } },
    ]);
  });

  it("appends when no slot was given", () => {
    const groups = [group("p", 0), group("a", 0, "p"), group("x", 5)];
    const plan = planGroupMove(groups, "x", "p", null);
    expect(plan.ok && plan.patches).toEqual([
      { id: "x", patch: { position: 1, parentId: "p" } },
    ]);
  });

  it("leaves groups outside the destination alone", () => {
    const groups = [group("p", 0), group("a", 0, "p"), group("x", 5)];
    const plan = planGroupMove(groups, "x", "p", 0);
    // p is neither the dragged group nor one of x's new siblings.
    expect(plan.ok && plan.groups.find((g) => g.id === "p")).toMatchObject({
      position: 0,
      parentId: null,
    });
  });

  it("treats a group whose parent no longer exists as top level", () => {
    // Its stored parentId names nothing, so it is already a sibling of a and b
    // and this is a reorder, not a reparent: no parentId patch.
    const orphaned = [group("a", 0), group("b", 1), group("z", 2, "gone")];
    const plan = planGroupMove(orphaned, "z", null, 0);
    expect(plan.ok && plan.patches).toEqual([
      { id: "z", patch: { position: 0 } },
      { id: "a", patch: { position: 1 } },
      { id: "b", patch: { position: 2 } },
    ]);
  });

  it("clamps a slot index that is past the end", () => {
    expect(planGroupMove(flat, "a", null, 99).ok).toBe(true);
  });
});
