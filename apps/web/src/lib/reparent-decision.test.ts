import { describe, expect, it } from "vitest";

import {
  decideReparent,
  groupingIsWarranted,
  type ParentSetBy,
} from "./github-sync";

/**
 * decideReparent is the crux of gh-51: it decides whether a re-sync re-homes a
 * spec after its `feature:` frontmatter changed, without clobbering a parent set
 * by hand. These cases map directly to the card's acceptance criteria.
 */
function row(
  parentId: string | null,
  parentSetBy: ParentSetBy,
  syncedFeatureKey: string | null,
) {
  return { parentId, parentSetBy, syncedFeatureKey };
}

describe("decideReparent", () => {
  it("homes a never-parented spec (first import)", () => {
    expect(decideReparent(row(null, null, null), "feature:auth").kind).toBe(
      "home",
    );
  });

  it("re-homes a system parent when the grouping key changed", () => {
    expect(
      decideReparent(row("p1", "system", "feature:auth"), "feature:login").kind,
    ).toBe("rehome");
  });

  it("leaves a user-set parent when the grouping key changed", () => {
    expect(
      decideReparent(row("p1", "user", "feature:auth"), "feature:login").kind,
    ).toBe("override");
  });

  it("does nothing when the key is unchanged", () => {
    expect(
      decideReparent(row("p1", "system", "feature:auth"), "feature:auth").kind,
    ).toBe("noop");
    expect(
      decideReparent(row("p1", "user", "feature:auth"), "feature:auth").kind,
    ).toBe("noop");
  });

  it("records a baseline for a backfilled system row with no tracked key", () => {
    expect(
      decideReparent(row("p1", "system", null), "feature:auth").kind,
    ).toBe("baseline");
  });

  it("does not re-home a user-set parent that has no tracked key", () => {
    // A user row whose key was never recorded: we must not touch it, and we do
    // not record a baseline for it either (only system rows get baselined).
    expect(decideReparent(row("p1", "user", null), "feature:auth").kind).toBe(
      "noop",
    );
  });

  it("keeps a deliberately unparented item in Unassigned", () => {
    // parentId null but user-owned: the person detached it; sync leaves it.
    expect(decideReparent(row(null, "user", "feature:auth"), "path:specs/x").kind).toBe(
      "noop",
    );
  });
});

/**
 * groupingIsWarranted gates *creation* of an auto Feature grouping. It exists
 * because `create_spec` writes each spec to its own folder, so a path-derived
 * key is unique per spec and used to mint one orphaned wrapper card per spec
 * (title-cased from the folder slug, no release, no parent).
 */
describe("groupingIsWarranted", () => {
  it("does not create a grouping for the sole spec in a folder", () => {
    // The reported bug: specs/per-scope-checkboxes-.../spec.md, one spec.
    expect(
      groupingIsWarranted("path:specs/per-scope-checkboxes-on-the-mcp", 1),
    ).toBe(false);
  });

  it("creates a grouping once a folder holds more than one spec", () => {
    expect(groupingIsWarranted("path:specs/checkout", 2)).toBe(true);
    expect(groupingIsWarranted("path:specs/checkout", 9)).toBe(true);
  });

  it("honours an explicit feature: frontmatter even for a single spec", () => {
    // The author named this grouping deliberately; one member is still a
    // grouping they asked for.
    expect(groupingIsWarranted("feature:Checkout", 1)).toBe(true);
  });

  it("does not create a grouping for a root-level spec", () => {
    // `spec:<id>` keys are inherently 1:1, so they were a guaranteed orphan.
    expect(groupingIsWarranted("spec:0f8e-1234", 1)).toBe(false);
  });

  it("treats a count of zero defensively", () => {
    expect(groupingIsWarranted("path:specs/x", 0)).toBe(false);
  });
});
