import { describe, expect, it } from "vitest";

import {
  applyFeatureFilters,
  countActiveFilters,
  filtersToQuery,
  parseFeatureFilters,
} from "./feature-filters";
import type { FeatureRecord } from "./store/types";

/**
 * The cycle filter dimension. Cycles are a second axis alongside releases, so
 * the point of these is less "does the filter work" than "do the two axes stay
 * independent": setting one must not imply or clear the other.
 */

function feature(over: Partial<FeatureRecord>): FeatureRecord {
  return {
    specId: "s1",
    title: "Item",
    level: "work",
    isDbNative: true,
    productId: "p1",
    status: "backlog",
    rank: null,
    tags: [],
    releaseId: null,
    cycleId: null,
    assigneeId: null,
    customFields: {},
    riceReach: null,
    riceImpact: null,
    riceConfidence: null,
    riceEffort: null,
    riceScore: null,
    path: "",
    blockedByCount: 0,
    blocksCount: 0,
    parentSpecId: null,
    childCount: 0,
    childDoneCount: 0,
    githubSummary: {
      openPrs: 0,
      mergedPrs: 0,
      issues: 0,
      branches: 0,
      total: 0,
    },
    ...over,
  };
}

const inCycle = feature({ specId: "a", cycleId: "c1" });
const otherCycle = feature({ specId: "b", cycleId: "c2" });
const noCycle = feature({ specId: "c", cycleId: null });

describe("cycle filter", () => {
  it("round-trips through the query string", () => {
    const filters = parseFeatureFilters({ cycle: "c1" });
    expect(filters.cycle).toBe("c1");
    expect(filtersToQuery(filters)).toContain("cycle=c1");
  });

  it("narrows to one cycle", () => {
    const out = applyFeatureFilters([inCycle, otherCycle, noCycle], {
      cycle: "c1",
    });
    expect(out.map((f) => f.specId)).toEqual(["a"]);
  });

  it('treats "none" as "in no cycle"', () => {
    const out = applyFeatureFilters([inCycle, otherCycle, noCycle], {
      cycle: "none",
    });
    expect(out.map((f) => f.specId)).toEqual(["c"]);
  });

  it("counts toward the active-filter total", () => {
    expect(countActiveFilters({ cycle: "c1" })).toBe(1);
    expect(countActiveFilters({ cycle: "c1", release: "r1" })).toBe(2);
  });

  it("is independent of the release filter (AND across the two axes)", () => {
    const both = feature({ specId: "both", cycleId: "c1", releaseId: "r1" });
    const cycleOnly = feature({ specId: "cycleOnly", cycleId: "c1" });
    const releaseOnly = feature({ specId: "releaseOnly", releaseId: "r1" });
    const items = [both, cycleOnly, releaseOnly];

    // Each alone matches on its own axis...
    expect(
      applyFeatureFilters(items, { cycle: "c1" }).map((f) => f.specId),
    ).toEqual(["both", "cycleOnly"]);
    expect(
      applyFeatureFilters(items, { release: "r1" }).map((f) => f.specId),
    ).toEqual(["both", "releaseOnly"]);
    // ...and together they intersect rather than one overriding the other.
    expect(
      applyFeatureFilters(items, { cycle: "c1", release: "r1" }).map(
        (f) => f.specId,
      ),
    ).toEqual(["both"]);
  });

  it("does not filter when unset", () => {
    const items = [inCycle, otherCycle, noCycle];
    expect(applyFeatureFilters(items, {})).toHaveLength(3);
  });
});
