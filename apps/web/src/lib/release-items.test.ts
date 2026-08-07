import { describe, expect, it } from "vitest";

import type { WorkspaceLevel } from "@specboards/core";

import { groupReleaseItemsByLevel, type ReleaseItem } from "./release-items";

const LEVELS: WorkspaceLevel[] = [
  { key: "initiative", label: "Initiative", position: 0, isLeaf: false },
  { key: "epic", label: "Epic", position: 1, isLeaf: false },
  { key: "feature", label: "Feature", position: 2, isLeaf: false },
  { key: "work", label: "Work Item", position: 3, isLeaf: true },
];

function item(partial: Partial<ReleaseItem> & { specId: string }): ReleaseItem {
  return {
    title: partial.specId,
    level: "feature",
    status: "backlog",
    productId: null,
    ...partial,
  };
}

describe("groupReleaseItemsByLevel", () => {
  it("groups by level, top level first", () => {
    const groups = groupReleaseItemsByLevel(
      [
        item({ specId: "w1", level: "work" }),
        item({ specId: "i1", level: "initiative" }),
        item({ specId: "f1", level: "feature" }),
      ],
      LEVELS,
    );
    expect(groups.map((g) => g.levelKey)).toEqual([
      "initiative",
      "feature",
      "work",
    ]);
    expect(groups.map((g) => g.levelLabel)).toEqual([
      "Initiative",
      "Feature",
      "Work Item",
    ]);
  });

  it("omits levels the release holds nothing at", () => {
    const groups = groupReleaseItemsByLevel(
      [item({ specId: "e1", level: "epic" })],
      LEVELS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.levelKey).toBe("epic");
  });

  it("orders items within a level by title", () => {
    const groups = groupReleaseItemsByLevel(
      [
        item({ specId: "b", title: "Beta" }),
        item({ specId: "a", title: "Alpha" }),
      ],
      LEVELS,
    );
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps items at an unknown level, sorted last under their raw key", () => {
    const groups = groupReleaseItemsByLevel(
      [
        item({ specId: "x", level: "retired" }),
        item({ specId: "f1", level: "feature" }),
      ],
      LEVELS,
    );
    expect(groups.map((g) => g.levelKey)).toEqual(["feature", "retired"]);
    expect(groups[1]!.levelLabel).toBe("retired");
  });

  it("returns nothing for an empty release", () => {
    expect(groupReleaseItemsByLevel([], LEVELS)).toEqual([]);
  });
});
