import { describe, expect, it } from "vitest";

import { computeRiceScore } from "./feature-helpers";
import { InvalidPatchError, parseFeaturePatch } from "./features-service";

describe("computeRiceScore", () => {
  it("computes Reach × Impact × Confidence/100 ÷ Effort", () => {
    // 1000 × 2 × 0.8 / 3 = 533.33…
    expect(
      computeRiceScore({
        riceReach: 1000,
        riceImpact: 2,
        riceConfidence: 80,
        riceEffort: 3,
      }),
    ).toBeCloseTo(533.333, 2);
  });

  it("is null until every input is present", () => {
    expect(
      computeRiceScore({ riceReach: 1000, riceImpact: 2, riceConfidence: 80, riceEffort: null }),
    ).toBeNull();
    expect(
      computeRiceScore({ riceReach: null, riceImpact: 2, riceConfidence: 80, riceEffort: 3 }),
    ).toBeNull();
  });

  it("is null when effort is zero or negative", () => {
    expect(
      computeRiceScore({ riceReach: 100, riceImpact: 1, riceConfidence: 50, riceEffort: 0 }),
    ).toBeNull();
  });
});

describe("parseFeaturePatch RICE validation", () => {
  it("accepts valid RICE inputs", () => {
    const patch = parseFeaturePatch({
      riceReach: 500,
      riceImpact: 0.5,
      riceConfidence: 90,
      riceEffort: 2,
    });
    expect(patch).toEqual({
      riceReach: 500,
      riceImpact: 0.5,
      riceConfidence: 90,
      riceEffort: 2,
    });
  });

  it("accepts null to clear a RICE input", () => {
    expect(parseFeaturePatch({ riceReach: null })).toEqual({ riceReach: null });
  });

  it("rejects an off-scale impact", () => {
    expect(() => parseFeaturePatch({ riceImpact: 4 })).toThrow(InvalidPatchError);
  });

  it("rejects confidence outside 0-100 or non-integer", () => {
    expect(() => parseFeaturePatch({ riceConfidence: 120 })).toThrow(InvalidPatchError);
    expect(() => parseFeaturePatch({ riceConfidence: 33.5 })).toThrow(InvalidPatchError);
  });

  it("rejects non-positive effort", () => {
    expect(() => parseFeaturePatch({ riceEffort: 0 })).toThrow(InvalidPatchError);
    expect(() => parseFeaturePatch({ riceEffort: -1 })).toThrow(InvalidPatchError);
  });
});
