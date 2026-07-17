import { describe, expect, it } from "vitest";

import {
  MAX_GROUP_DEPTH,
  descendantGroupIds,
  groupDepth,
  groupKeyFromName,
  wouldCreateCycle,
  wouldExceedDepth,
} from "./product-groups.js";

/** platform > payments > cards; data is a sibling top-level group. */
const TREE = [
  { id: "platform", parentId: null },
  { id: "payments", parentId: "platform" },
  { id: "cards", parentId: "payments" },
  { id: "data", parentId: null },
];

describe("groupKeyFromName", () => {
  it("slugifies a name", () => {
    expect(groupKeyFromName("Payments Platform", new Set())).toBe(
      "payments-platform",
    );
  });

  it("disambiguates against taken keys", () => {
    expect(groupKeyFromName("Data", new Set(["data"]))).toBe("data-2");
  });

  it("falls back to 'group' for empty slugs", () => {
    expect(groupKeyFromName("!!!", new Set())).toBe("group");
  });
});

describe("descendantGroupIds", () => {
  it("includes the group itself and all descendants", () => {
    expect(descendantGroupIds(TREE, "platform")).toEqual(
      new Set(["platform", "payments", "cards"]),
    );
  });

  it("returns just the group for a leaf", () => {
    expect(descendantGroupIds(TREE, "cards")).toEqual(new Set(["cards"]));
  });

  it("does not loop on a corrupt cyclic tree", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect(descendantGroupIds(cyclic, "a")).toEqual(new Set(["a", "b"]));
  });
});

describe("groupDepth", () => {
  it("counts from 1 at the top level", () => {
    expect(groupDepth(TREE, "platform")).toBe(1);
    expect(groupDepth(TREE, "payments")).toBe(2);
    expect(groupDepth(TREE, "cards")).toBe(3);
  });

  it("terminates on a corrupt cyclic chain", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect(groupDepth(cyclic, "a")).toBe(2);
  });
});

describe("wouldCreateCycle", () => {
  it("rejects parenting a group to itself", () => {
    expect(wouldCreateCycle(TREE, "platform", "platform")).toBe(true);
  });

  it("rejects parenting to a descendant", () => {
    expect(wouldCreateCycle(TREE, "platform", "cards")).toBe(true);
  });

  it("allows parenting to an unrelated group or the top level", () => {
    expect(wouldCreateCycle(TREE, "payments", "data")).toBe(false);
    expect(wouldCreateCycle(TREE, "payments", null)).toBe(false);
  });
});

describe("wouldExceedDepth", () => {
  it("allows a new group under an existing chain within the cap", () => {
    // cards is at depth 3; a new child lands at 4 = MAX_GROUP_DEPTH.
    expect(wouldExceedDepth(TREE, "new-group", "cards")).toBe(false);
  });

  it("rejects a new group past the cap", () => {
    const deep = [
      ...TREE,
      { id: "d4", parentId: "cards" }, // depth 4
    ];
    expect(wouldExceedDepth(deep, "new-group", "d4")).toBe(true);
  });

  it("accounts for the moved group's own subtree height", () => {
    // Moving platform (height 3) under data (depth 1) makes cards depth 4: ok.
    expect(wouldExceedDepth(TREE, "platform", "data")).toBe(false);
    // Under payments-like depth 2 it would reach 5: rejected (also a cycle,
    // but depth alone must catch the equivalent non-cyclic case).
    const wide = [...TREE, { id: "other-l2", parentId: "data" }];
    expect(wouldExceedDepth(wide, "platform", "other-l2")).toBe(true);
  });

  it("exports a cap of 4", () => {
    expect(MAX_GROUP_DEPTH).toBe(4);
  });
});
