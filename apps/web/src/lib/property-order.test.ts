import { describe, expect, it } from "vitest";

import type { PropertyDef, PropertyEntity } from "@specboards/core";

import { reorderProperty } from "./property-order";

/** A property definition with only the fields the ordering cares about. */
function prop(
  id: string,
  position: number,
  entity: PropertyEntity = "item",
): PropertyDef {
  return {
    id,
    key: id,
    label: id,
    type: "text",
    entity,
    options: [],
    levels: null,
    position,
  };
}

describe("reorderProperty", () => {
  it("moves a property up by one place", () => {
    const list = [prop("end", 0), prop("start", 1), prop("owner", 2)];
    expect(reorderProperty(list, "start", -1)).toEqual([
      { id: "start", position: 0 },
      { id: "end", position: 1 },
    ]);
  });

  it("moves a property down by one place", () => {
    const list = [prop("end", 0), prop("start", 1), prop("owner", 2)];
    expect(reorderProperty(list, "end", 1)).toEqual([
      { id: "start", position: 0 },
      { id: "end", position: 1 },
    ]);
  });

  it("writes only the rows that actually move", () => {
    const list = [prop("a", 0), prop("b", 1), prop("c", 2), prop("d", 3)];
    // c and d trade places; a and b are untouched and must not be written.
    expect(reorderProperty(list, "d", -1)).toEqual([
      { id: "d", position: 2 },
      { id: "c", position: 3 },
    ]);
  });

  it("refuses to move the first property up", () => {
    const list = [prop("a", 0), prop("b", 1)];
    expect(reorderProperty(list, "a", -1)).toEqual([]);
  });

  it("refuses to move the last property down", () => {
    const list = [prop("a", 0), prop("b", 1)];
    expect(reorderProperty(list, "b", 1)).toEqual([]);
  });

  it("returns nothing for an unknown property", () => {
    expect(reorderProperty([prop("a", 0)], "missing", 1)).toEqual([]);
  });

  it("is a no-op on a group of one", () => {
    expect(reorderProperty([prop("only", 0)], "only", 1)).toEqual([]);
    expect(reorderProperty([prop("only", 0)], "only", -1)).toEqual([]);
  });

  it("renumbers a legacy list whose positions are all zero", () => {
    // `position` defaults to 0, so properties created before the column was
    // used sort by created_at behind it. Swapping two zeroes would be a
    // visible no-op; assigning ordinals repairs the list on first use.
    const list = [prop("a", 0), prop("b", 0), prop("c", 0)];
    expect(reorderProperty(list, "c", -1)).toEqual([
      { id: "c", position: 1 },
      { id: "b", position: 2 },
    ]);
  });

  it("steps over a release property when moving an item property", () => {
    // Positions are per entity, so the item properties are 0,1 and the release
    // property is its own 0. Moving `b` up must swap it with `a`, not with the
    // release row rendered between them.
    const list = [
      prop("a", 0),
      prop("release-risk", 0, "release"),
      prop("b", 1),
    ];
    expect(reorderProperty(list, "b", -1)).toEqual([
      { id: "b", position: 0 },
      { id: "a", position: 1 },
    ]);
  });

  it("orders release properties independently of item properties", () => {
    const list = [
      prop("a", 0),
      prop("b", 1),
      prop("r1", 0, "release"),
      prop("r2", 1, "release"),
    ];
    expect(reorderProperty(list, "r2", -1)).toEqual([
      { id: "r2", position: 0 },
      { id: "r1", position: 1 },
    ]);
  });

  it("leaves the group untouched when the order is already correct", () => {
    const list = [prop("a", 0), prop("b", 1)];
    // Moving a down and b up describe the same result, and both write both rows.
    expect(reorderProperty(list, "a", 1)).toEqual([
      { id: "b", position: 0 },
      { id: "a", position: 1 },
    ]);
  });
});
