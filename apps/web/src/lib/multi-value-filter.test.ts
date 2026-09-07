import { describe, expect, it } from "vitest";

import {
  applyFeatureFilters,
  clearFilterKey,
  countActiveFilters,
  filtersToQuery,
  hasActiveFilters,
  parseFeatureFilters,
  toggleFilterValue,
  type FeatureFilters,
} from "./feature-filters";
import type { FeatureRecord } from "./store/types";

/**
 * Filter dimensions accept several values: OR within a dimension, AND across.
 *
 * The three properties worth pinning down are the ones a reader cannot infer
 * from the types. A URL written before this change still parses (old links and
 * saved views must not break). Repeated params, not a separator, so a value
 * containing punctuation survives the round trip. And the badge counts
 * dimensions rather than values, so widening a filter never makes it climb.
 */

function feat(over: Partial<FeatureRecord>): FeatureRecord {
  return {
    specId: "s",
    title: "Item",
    status: "backlog",
    tags: [],
    releaseId: null,
    cycleId: null,
    assigneeId: null,
    parentSpecId: null,
    productId: "p1",
    customFields: {},
    ...over,
  } as unknown as FeatureRecord;
}

describe("parsing multi-value filters", () => {
  it("reads repeated params into a list", () => {
    const filters = parseFeatureFilters({ status: ["ready", "in_progress"] });
    expect(filters.status).toEqual(["ready", "in_progress"]);
  });

  it("still reads a single-valued link written before this existed", () => {
    const filters = parseFeatureFilters({ status: "ready", tag: "area:web" });
    expect(filters.status).toEqual(["ready"]);
    expect(filters.tag).toEqual(["area:web"]);
  });

  it("drops blanks and duplicates rather than filtering on them", () => {
    const filters = parseFeatureFilters({
      status: ["ready", "", "  ", "ready"],
    });
    expect(filters.status).toEqual(["ready"]);
    // A dimension with nothing left is absent, not an empty array, so
    // `hasActiveFilters` and the chip bar agree about it.
    expect(parseFeatureFilters({ status: ["", " "] }).status).toBeUndefined();
  });
});

describe("serializing multi-value filters", () => {
  it("round-trips a widened dimension", () => {
    const filters: FeatureFilters = { status: ["ready", "in_progress"] };
    expect(filtersToQuery(filters)).toBe("status=ready&status=in_progress");
    expect(parseFeatureFilters({ status: ["ready", "in_progress"] })).toEqual(
      filters,
    );
  });

  it("survives a value carrying the separator a joined format would use", () => {
    // Repeated params rather than "a,b" is the whole reason this holds: a tag
    // name is user data, and one containing a comma must not split in two.
    const filters: FeatureFilters = { tag: ["a,b", "c"] };
    const query = filtersToQuery(filters);
    const round = parseFeatureFilters(
      Object.fromEntries([["tag", new URLSearchParams(query).getAll("tag")]]),
    );
    expect(round.tag).toEqual(["a,b", "c"]);
  });
});

describe("matching", () => {
  const ready = feat({ specId: "ready", status: "ready" });
  const progress = feat({ specId: "progress", status: "in_progress" });
  const done = feat({ specId: "done", status: "done" });
  const rows = [ready, progress, done];

  it("ORs values inside one dimension", () => {
    const out = applyFeatureFilters(rows, {
      status: ["ready", "in_progress"],
    });
    expect(out.map((f) => f.specId)).toEqual(["ready", "progress"]);
  });

  it("ANDs across dimensions", () => {
    const mine = feat({ specId: "mine", status: "ready", assigneeId: "u1" });
    const out = applyFeatureFilters([...rows, mine], {
      status: ["ready", "in_progress"],
      assignee: ["u1"],
    });
    expect(out.map((f) => f.specId)).toEqual(["mine"]);
  });

  it("matches an item carrying any one of several tags", () => {
    const web = feat({ specId: "web", tags: ["area:web"] });
    const api = feat({ specId: "api", tags: ["area:api"] });
    const both = feat({ specId: "both", tags: ["area:web", "area:api"] });
    const none = feat({ specId: "none", tags: [] });
    const out = applyFeatureFilters([web, api, both, none], {
      tag: ["area:web", "area:api"],
    });
    // `both` appears once, not once per matching tag.
    expect(out.map((f) => f.specId)).toEqual(["web", "api", "both"]);
  });

  it("mixes the 'not set' sentinel with real values", () => {
    const scheduled = feat({ specId: "scheduled", releaseId: "r1" });
    const elsewhere = feat({ specId: "elsewhere", releaseId: "r2" });
    const unscheduled = feat({ specId: "unscheduled", releaseId: null });
    const out = applyFeatureFilters([scheduled, elsewhere, unscheduled], {
      release: ["r1", "none"],
    });
    expect(out.map((f) => f.specId)).toEqual(["scheduled", "unscheduled"]);
  });
});

describe("toggling", () => {
  it("adds, then removes, one value at a time", () => {
    let filters: FeatureFilters = {};
    filters = toggleFilterValue(filters, "status", "ready");
    expect(filters.status).toEqual(["ready"]);
    filters = toggleFilterValue(filters, "status", "in_progress");
    expect(filters.status).toEqual(["ready", "in_progress"]);
    filters = toggleFilterValue(filters, "status", "ready");
    expect(filters.status).toEqual(["in_progress"]);
  });

  it("drops the dimension when its last value is unticked", () => {
    const filters = toggleFilterValue({ status: ["ready"] }, "status", "ready");
    expect(filters.status).toBeUndefined();
    expect(hasActiveFilters(filters)).toBe(false);
  });

  it("leaves the other dimensions alone", () => {
    const filters = toggleFilterValue(
      { status: ["ready"], assignee: ["u1"] },
      "status",
      "done",
    );
    expect(filters.assignee).toEqual(["u1"]);
  });

  it("clears a whole dimension at once", () => {
    const filters = clearFilterKey(
      { status: ["ready", "in_progress"], assignee: ["u1"] },
      "status",
    );
    expect(filters.status).toBeUndefined();
    expect(filters.assignee).toEqual(["u1"]);
  });
});

describe("the active-filter badge", () => {
  it("counts dimensions, not values", () => {
    // Widening "Status is Ready" to "Ready or In progress" is still one filter
    // the user set; a badge that ticked to 2 would read as a second one.
    expect(countActiveFilters({ status: ["ready"] })).toBe(1);
    expect(countActiveFilters({ status: ["ready", "in_progress"] })).toBe(1);
    expect(
      countActiveFilters({ status: ["ready", "in_progress"], tag: ["a"] }),
    ).toBe(2);
  });

  it("ignores an emptied dimension", () => {
    expect(countActiveFilters({ status: [] })).toBe(0);
    expect(hasActiveFilters({ status: [] })).toBe(false);
  });

  it("does not count the shipped view toggle", () => {
    expect(countActiveFilters({ showShipped: true })).toBe(0);
  });
});
