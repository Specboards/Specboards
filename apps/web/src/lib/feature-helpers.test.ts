import { describe, expect, it } from "vitest";

import { pluralLevel } from "./feature-helpers";

/**
 * Pluralising a level label.
 *
 * The UI says "3 features", "No work items yet", "Suggest work items". It used
 * to append the word "items", which on a level named "Work Item" produced "work
 * item items" and read as a bug because it was one. Found by shipping the
 * breakdown button and looking at it.
 */
describe("pluralising a configured level label", () => {
  it("pluralises the ordinary case", () => {
    expect(pluralLevel("Epic")).toBe("Epics");
    expect(pluralLevel("feature")).toBe("features");
  });

  it("does not say work item items", () => {
    expect(pluralLevel("work item")).toBe("work items");
  });

  it("leaves a label that is already plural alone", () => {
    // A workspace may well name its levels plurally. "Storieses" is worse than
    // anything this function exists to prevent.
    expect(pluralLevel("Stories")).toBe("Stories");
    expect(pluralLevel("Bets")).toBe("Bets");
  });

  it("handles the endings that need more than an s", () => {
    expect(pluralLevel("Story")).toBe("Stories");
    expect(pluralLevel("Batch")).toBe("Batches");
    expect(pluralLevel("Fix")).toBe("Fixes");
  });

  it("keeps a vowel before the y", () => {
    // "Journeies" is the failure the naive y-rule produces, and "Journey" is a
    // plausible level name for a product team.
    expect(pluralLevel("Journey")).toBe("Journeys");
  });

  it("returns an empty label unchanged rather than a lone s", () => {
    expect(pluralLevel("   ")).toBe("");
  });
});
