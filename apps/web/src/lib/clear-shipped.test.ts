import { describe, expect, it } from "vitest";

import {
  filtersToQuery,
  hideDoneShippedItems,
  parseFeatureFilters,
  type FeatureFilters,
} from "./feature-filters";
import { selectableReleases } from "./store/types";
import type { FeatureRecord, ReleaseRecord } from "./store/types";

function feat(title: string, status: string, releaseId: string | null): FeatureRecord {
  return { title, status, releaseId } as unknown as FeatureRecord;
}

function rel(id: string, status: ReleaseRecord["status"]): ReleaseRecord {
  return {
    id,
    name: id,
    productId: null,
    status,
    startDate: null,
    targetDate: null,
    shippedDate: null,
    notes: null,
    itemCount: 0,
  };
}

describe("hideDoneShippedItems", () => {
  const shipped = new Set(["r-shipped"]);
  const rows = [
    feat("done+shipped", "done", "r-shipped"),
    feat("done+active", "done", "r-active"),
    feat("inprogress+shipped", "in_progress", "r-shipped"),
    feat("done+norelease", "done", null),
  ];

  it("drops only items that are done AND in a shipped release", () => {
    expect(hideDoneShippedItems(rows, shipped).map((f) => f.title)).toEqual([
      "done+active",
      "inprogress+shipped",
      "done+norelease",
    ]);
  });

  it("is a no-op when there are no shipped releases", () => {
    expect(hideDoneShippedItems(rows, new Set()).length).toBe(rows.length);
  });
});

describe("showShipped in the filter round-trip", () => {
  it("parses showShipped from the query", () => {
    expect(parseFeatureFilters({ showShipped: "1" }).showShipped).toBe(true);
    expect(parseFeatureFilters({}).showShipped).toBeUndefined();
  });

  it("serializes showShipped back", () => {
    const filters: FeatureFilters = { showShipped: true };
    expect(filtersToQuery(filters)).toBe("showShipped=1");
    expect(filtersToQuery({})).toBe("");
  });
});

describe("selectableReleases", () => {
  const releases = [rel("a", "planned"), rel("b", "in_progress"), rel("c", "shipped")];

  it("excludes shipped releases", () => {
    expect(selectableReleases(releases).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps a currently-assigned shipped release so its value never vanishes", () => {
    expect(selectableReleases(releases, "c").map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
