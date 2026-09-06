import { describe, expect, it } from "vitest";

import type { TagDef } from "@specboards/core";

import { mergeTagOptions } from "./tags-service";

function tag(name: string, position: number): TagDef {
  return { id: name, name, position };
}

/**
 * What the tag filter menus offer.
 *
 * Before the registry these were built from the items currently in view, which
 * meant a tag vanished from the menu the moment a filter narrowed the set, and
 * a tag nobody had used yet did not exist as far as filtering was concerned.
 */
describe("mergeTagOptions", () => {
  const registry = [tag("area:web", 0), tag("tier-1", 1)];

  it("offers a registry tag no item carries yet", () => {
    expect(mergeTagOptions(registry, [])).toEqual(["area:web", "tier-1"]);
  });

  it("keeps the registry's own order rather than alphabetising it", () => {
    // The order is something an admin arranged; sorting it would throw that away.
    expect(mergeTagOptions([tag("zeta", 0), tag("alpha", 1)], [])).toEqual([
      "zeta",
      "alpha",
    ]);
  });

  it("keeps a tag left on an item by a deleted definition", () => {
    // Deleting a tag hides values rather than destroying them, so those values
    // still exist on cards and still have to be filterable.
    expect(
      mergeTagOptions(registry, [{ tags: ["area:web", "retired"] }]),
    ).toEqual(["area:web", "tier-1", "retired"]);
  });

  it("sorts the strays, since nothing else gives them an order", () => {
    expect(mergeTagOptions([], [{ tags: ["zeta"] }, { tags: ["alpha"] }])).toEqual(
      ["alpha", "zeta"],
    );
  });

  it("does not list a legacy casing beside the registry's spelling", () => {
    // An old card tagged "Area:Web" before the registry existed must not put a
    // second entry in the menu that filters to a different set.
    expect(mergeTagOptions(registry, [{ tags: ["Area:Web"] }])).toEqual([
      "area:web",
      "tier-1",
    ]);
  });

  it("lists a stray once however many items carry it", () => {
    expect(
      mergeTagOptions([], [{ tags: ["x"] }, { tags: ["x"] }, { tags: ["X"] }]),
    ).toEqual(["x"]);
  });

  it("ignores empty tag values", () => {
    expect(mergeTagOptions([], [{ tags: ["", "  ", "real"] }])).toEqual([
      "real",
    ]);
  });
});
