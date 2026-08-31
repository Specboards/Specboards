import { describe, expect, it } from "vitest";

import type { WorkspaceLevel } from "@specboards/core";

import { resolveActiveLevel } from "./active-level";

/** The default Initiative -> Epic -> Feature -> Work Item hierarchy. */
const LEVELS: WorkspaceLevel[] = [
  { key: "initiative", label: "Initiative", position: 0, isLeaf: false },
  { key: "epic", label: "Epic", position: 1, isLeaf: false },
  { key: "feature", label: "Feature", position: 2, isLeaf: false },
  { key: "work", label: "Work Item", position: 3, isLeaf: true },
];

describe("resolveActiveLevel", () => {
  it("honours an explicit level even when that level is empty", () => {
    // Someone who clicked "Features" wants Features, empty or not.
    expect(resolveActiveLevel(LEVELS, "feature", ["work"]).key).toBe("feature");
  });

  it("falls back to the planning altitude when nothing is known about content", () => {
    expect(resolveActiveLevel(LEVELS, undefined).key).toBe("feature");
  });

  it("keeps the planning altitude when it has cards", () => {
    expect(resolveActiveLevel(LEVELS, undefined, ["feature", "work"]).key).toBe(
      "feature",
    );
  });

  it("lands on the leaf when only leaf items exist", () => {
    // The case that made a new self-host show "No feature items yet" while its
    // four onboarding cards sat under Work Items.
    expect(resolveActiveLevel(LEVELS, undefined, ["work"]).key).toBe("work");
  });

  it("prefers a populated level below the default over one above it", () => {
    expect(
      resolveActiveLevel(LEVELS, undefined, ["initiative", "work"]).key,
    ).toBe("work");
  });

  it("looks above the default when nothing below is populated", () => {
    expect(resolveActiveLevel(LEVELS, undefined, ["epic"]).key).toBe("epic");
    expect(resolveActiveLevel(LEVELS, undefined, ["initiative"]).key).toBe(
      "initiative",
    );
  });

  it("falls back to the default on a genuinely empty board", () => {
    expect(resolveActiveLevel(LEVELS, undefined, []).key).toBe("feature");
  });

  it("ignores an unknown level key", () => {
    expect(resolveActiveLevel(LEVELS, "nonsense", ["work"]).key).toBe("work");
  });
});
