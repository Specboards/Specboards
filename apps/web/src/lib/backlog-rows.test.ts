import { describe, expect, it } from "vitest";

import { buildLevelRows } from "@/lib/backlog-rows";

/** Minimal levelled item; the real FeatureRecord is a superset. */
function item(specId: string, level: string, parentSpecId: string | null = null) {
  return { specId, level, parentSpecId };
}

describe("buildLevelRows", () => {
  const items = [
    item("i1", "initiative"),
    item("e1", "epic", "i1"),
    item("e2", "epic", "i1"),
    item("f1", "feature", "e1"),
    item("f2", "feature", "e2"),
    item("w1", "work", "f1"),
  ];

  it("shows the active level at depth 0 with its children nested", () => {
    expect(buildLevelRows(items, "epic", "feature")).toEqual([
      { feature: item("e1", "epic", "i1"), depth: 0 },
      { feature: item("f1", "feature", "e1"), depth: 1 },
      { feature: item("e2", "epic", "i1"), depth: 0 },
      { feature: item("f2", "feature", "e2"), depth: 1 },
    ]);
  });

  it("reaches items nested several levels deep (the old builder dropped them)", () => {
    const rows = buildLevelRows(items, "feature", "work");
    expect(rows.map((r) => r.feature.specId)).toEqual(["f1", "w1", "f2"]);
  });

  it("is flat at the leaf level, where there is nothing to group", () => {
    const rows = buildLevelRows(items, "work", null);
    expect(rows).toEqual([{ feature: item("w1", "work", "f1"), depth: 0 }]);
  });

  it("keeps top-level items with no parent", () => {
    const orphan = [...items, item("f3", "feature")];
    const rows = buildLevelRows(orphan, "feature", "work");
    expect(rows.map((r) => r.feature.specId)).toEqual(["f1", "w1", "f2", "f3"]);
  });

  it("omits children whose parent is absent from the level's rows", () => {
    // f9's parent epic isn't in the set (e.g. hidden as done-and-shipped), so
    // f9 isn't shown at epic level; it surfaces at its own level instead.
    const withHiddenParent = [...items, item("f9", "feature", "e9")];
    const rows = buildLevelRows(withHiddenParent, "epic", "feature");
    expect(rows.map((r) => r.feature.specId)).not.toContain("f9");
    expect(
      buildLevelRows(withHiddenParent, "feature", "work").map(
        (r) => r.feature.specId,
      ),
    ).toContain("f9");
  });

  it("preserves input order within each tier", () => {
    const reversed = [
      item("e2", "epic", "i1"),
      item("e1", "epic", "i1"),
      item("f1b", "feature", "e1"),
      item("f1a", "feature", "e1"),
    ];
    expect(buildLevelRows(reversed, "epic", "feature").map((r) => r.feature.specId)).toEqual([
      "e2",
      "e1",
      "f1b",
      "f1a",
    ]);
  });

  it("returns nothing when the level has no items", () => {
    expect(buildLevelRows(items, "nonexistent", null)).toEqual([]);
  });
});
