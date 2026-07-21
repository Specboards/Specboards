import { describe, expect, it } from "vitest";

import { compareReleases, compareShippedReleases } from "./types";

/** Minimal release shapes for the comparators (only the compared fields). */
function planned(name: string, targetDate: string | null) {
  return { name, targetDate };
}
function shipped(
  name: string,
  shippedDate: string | null,
  targetDate: string | null = null,
) {
  return { name, shippedDate, targetDate };
}

describe("compareReleases (planned ordering)", () => {
  it("orders dated releases ascending, undated last, then by name", () => {
    const sorted = [
      planned("later", "2026-09-01"),
      planned("undated", null),
      planned("earlier", "2026-08-01"),
    ].sort(compareReleases);
    expect(sorted.map((r) => r.name)).toEqual(["earlier", "later", "undated"]);
  });
});

describe("compareShippedReleases (newest-first)", () => {
  it("puts the most recently shipped release first", () => {
    const sorted = [
      shipped("v1", "2026-07-01"),
      shipped("v3", "2026-09-01"),
      shipped("v2", "2026-08-01"),
    ].sort(compareShippedReleases);
    expect(sorted.map((r) => r.name)).toEqual(["v3", "v2", "v1"]);
  });

  it("falls back to the planned target date when no ship date is stamped", () => {
    // Older release has no stamp; its planned targetDate stands in for sorting.
    const sorted = [
      shipped("stamped-old", "2026-07-01"),
      shipped("unstamped-new", null, "2026-09-01"),
    ].sort(compareShippedReleases);
    expect(sorted.map((r) => r.name)).toEqual(["unstamped-new", "stamped-old"]);
  });

  it("sorts releases with no date at all to the end", () => {
    const sorted = [
      shipped("no-date", null, null),
      shipped("dated", "2026-08-01"),
    ].sort(compareShippedReleases);
    expect(sorted.map((r) => r.name)).toEqual(["dated", "no-date"]);
  });

  it("is the inverse of the planned ordering for the same ship dates", () => {
    const releases = [
      shipped("a", "2026-07-01"),
      shipped("b", "2026-08-01"),
      shipped("c", "2026-09-01"),
    ];
    const newestFirst = [...releases].sort(compareShippedReleases).map((r) => r.name);
    const oldestFirst = [...releases]
      .sort((x, y) => compareReleases({ name: x.name, targetDate: x.shippedDate }, { name: y.name, targetDate: y.shippedDate }))
      .map((r) => r.name);
    expect(newestFirst).toEqual([...oldestFirst].reverse());
  });
});
