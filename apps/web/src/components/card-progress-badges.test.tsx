import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChildProgressBadge,
  ParentLevelBadge,
  childLevelLabel,
  parentLevelLabel,
} from "./card-field-badges";
import type { WorkspaceLevel } from "@specboards/core";

/**
 * What a card says about its children and its parent.
 *
 * This is pinned in the markup rather than left to the helpers alone because
 * the defect it replaces was entirely a wording one: the badge said "epic" at
 * every altitude, which was right for an Initiative by coincidence and wrong
 * for everything else. A helper returning "Features" proves nothing if the
 * badge does not put it on the card.
 */

const DEFAULT: WorkspaceLevel[] = [
  { key: "initiative", label: "Initiative", position: 0, isLeaf: false },
  { key: "epic", label: "Epic", position: 1, isLeaf: false },
  { key: "feature", label: "Feature", position: 2, isLeaf: false },
  { key: "work", label: "Work Item", position: 3, isLeaf: true },
];

const RENAMED: WorkspaceLevel[] = [
  { key: "bet", label: "Bet", position: 0, isLeaf: false },
  { key: "story", label: "Story", position: 1, isLeaf: true },
];

function progress(
  level: string,
  childDoneCount: number,
  childCount: number,
  levels = DEFAULT,
) {
  return renderToStaticMarkup(
    <ChildProgressBadge
      feature={{ level, childCount, childDoneCount }}
      levels={levels}
    />,
  );
}

describe("the child-progress badge", () => {
  it("names the level the children are at, not the card's own", () => {
    // The whole point: an Epic's children are Features. Saying "epic 3/5" here
    // described the parent while counting the children.
    expect(progress("epic", 3, 5)).toContain("3/5 Features done");
    expect(progress("epic", 3, 5)).not.toContain("Epics");
  });

  it("reads as progress rather than as an identifier", () => {
    // "3/5" alone is a position or an id. The word carries the meaning.
    expect(progress("initiative", 1, 4)).toContain("done");
  });

  it("follows a renamed hierarchy", () => {
    expect(progress("bet", 2, 7, RENAMED)).toContain("2/7 Stories done");
  });

  it("shows nothing for a card with no children", () => {
    expect(progress("feature", 0, 0)).toBe("");
  });

  it("spells out the same figure in the tooltip", () => {
    expect(progress("epic", 3, 5)).toContain("3 of 5 Features done");
  });
});

describe("the parent badge", () => {
  function parent(level: string, parentSpecId: string | null, levels = DEFAULT) {
    return renderToStaticMarkup(
      <ParentLevelBadge feature={{ level, parentSpecId }} levels={levels} />,
    );
  }

  it("names the parent's level instead of saying 'sub'", () => {
    expect(parent("feature", "abc")).toContain("Epic");
    expect(parent("feature", "abc")).not.toContain("sub");
  });

  it("shows nothing for a top-level card", () => {
    expect(parent("initiative", null)).toBe("");
  });
});

describe("level labels", () => {
  it("pluralizes the child level", () => {
    expect(childLevelLabel("initiative", DEFAULT)).toBe("Epics");
    expect(childLevelLabel("feature", DEFAULT)).toBe("Work Items");
  });

  it("falls back to a generic word below the leaf", () => {
    // Reachable when an admin removes a level that cards still sit at: better a
    // vague word than a confidently wrong level name.
    expect(childLevelLabel("work", DEFAULT)).toBe("items");
    expect(childLevelLabel("nonsense", DEFAULT)).toBe("items");
  });

  it("resolves the parent level, and falls back above the top", () => {
    expect(parentLevelLabel("work", DEFAULT)).toBe("Feature");
    expect(parentLevelLabel("initiative", DEFAULT)).toBe("Parent");
  });
});
