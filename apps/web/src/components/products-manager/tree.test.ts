import { MAX_GROUP_DEPTH } from "@specboards/core";
import { describe, expect, it } from "vitest";

import type { ProductGroupRecord, ProductRecord } from "@/lib/store/types";

import {
  childGroupsOf,
  effectiveParentId,
  flattenGroupTree,
  legalParentOptions,
  productsOf,
  ungroupedProducts,
} from "./tree";

/**
 * Reading the product tree.
 *
 * Two behaviours here are load-bearing and were previously only observable by
 * rendering the page: a group whose parent no longer exists still has to
 * appear somewhere, and the parent choices offered for a move have to account
 * for how tall the moving subtree is, not just where it currently sits.
 */

function group(
  id: string,
  position: number,
  parentId: string | null = null,
  name = id,
): ProductGroupRecord {
  return { id, name, parentId, position } as ProductGroupRecord;
}

function product(
  id: string,
  position: number,
  groupId: string | null = null,
  name = id,
): ProductRecord {
  return { id, name, groupId, position } as ProductRecord;
}

describe("sibling order", () => {
  it("orders by position, then by name to break a tie", () => {
    const groups = [group("b", 1), group("z", 0), group("a", 1)];
    expect(childGroupsOf(groups, null).map((g) => g.id)).toEqual([
      "z",
      "a",
      "b",
    ]);
  });

  it("applies the same order to a group's products and to the ungrouped ones", () => {
    const products = [
      product("p2", 1, "g"),
      product("p1", 0, "g"),
      product("u2", 1),
      product("u1", 0),
    ];
    expect(productsOf(products, "g").map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(ungroupedProducts(products).map((p) => p.id)).toEqual(["u1", "u2"]);
  });
});

describe("a group whose parent no longer exists", () => {
  const stranded = group("z", 1, "deleted");
  const orphaned = [group("a", 0), stranded];

  it("resolves to the top level rather than to a missing parent", () => {
    expect(effectiveParentId(orphaned, stranded)).toBeNull();
  });

  it("is listed at the top level, so it never disappears from the tree", () => {
    expect(childGroupsOf(orphaned, null).map((g) => g.id)).toEqual(["a", "z"]);
    expect(
      flattenGroupTree(orphaned).map((r) => [r.group.id, r.depth]),
    ).toEqual([
      ["a", 0],
      ["z", 0],
    ]);
  });
});

describe("flattenGroupTree", () => {
  it("walks depth-first and reports each group's depth", () => {
    const groups = [
      group("a", 0),
      group("a1", 0, "a"),
      group("a1a", 0, "a1"),
      group("b", 1),
    ];
    expect(flattenGroupTree(groups).map((r) => [r.group.id, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a1a", 2],
      ["b", 0],
    ]);
  });

  it("terminates on a parent cycle rather than recursing forever", () => {
    // Neither row is reachable from the top level, so neither is emitted. That
    // is the documented limit, not an oversight: the store refuses a parent
    // change that would create a cycle, so these rows cannot exist without
    // someone writing them around the API. What matters here is that the walk
    // ends.
    const cyclic = [group("x", 0, "y"), group("y", 1, "x")];
    expect(flattenGroupTree(cyclic)).toEqual([]);
  });
});

describe("legalParentOptions", () => {
  /** A chain a > b > c > d, which is exactly the depth cap. */
  const b = group("b", 0, "a");
  const d = group("d", 0, "c");
  const chain = [group("a", 0), b, group("c", 0, "b"), d];

  it("offers, for a new group, every parent with room for one more level", () => {
    const ids = legalParentOptions(chain, null).map((r) => r.group.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(ids).not.toContain("d");
  });

  it("excludes the moving group's own subtree", () => {
    const ids = legalParentOptions(chain, b).map((r) => r.group.id);
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
    expect(ids).not.toContain("d");
  });

  it("accounts for how tall the moving subtree is, not just where it sits", () => {
    // Moving b takes c and d with it: three levels, so a parent is only legal
    // at the top. `a` qualifies because that is where b already is, and `e`
    // because it is the top of a separate chain. Nothing deeper is offered.
    const groups = [...chain, group("e", 1)];
    expect(legalParentOptions(groups, b).map((r) => r.group.id)).toEqual([
      "a",
      "e",
    ]);
    // A leaf, by contrast, fits under anything that is not already at the cap.
    expect(legalParentOptions(groups, d).map((r) => r.group.id)).toEqual([
      "a",
      "b",
      "c",
      "e",
    ]);
  });

  it("keeps the cap it is enforcing in step with core", () => {
    // The expectations above are written against a cap of 4. If the cap moves
    // and this is the only thing that fails, the cases need rewriting, not the
    // code.
    expect(MAX_GROUP_DEPTH).toBe(4);
  });
});
