import { describe, expect, it } from "vitest";

import {
  applyFeatureFilters,
  countActiveFilters,
  filtersToQuery,
  hasActiveFilters,
  parseCustomDateFilters,
  type FeatureFilters,
} from "./feature-filters";
import type { FeatureRecord } from "./store/types";

function feat(title: string, due: string | null): FeatureRecord {
  return {
    title,
    customFields: due === null ? {} : { due },
  } as unknown as FeatureRecord;
}

describe("parseCustomDateFilters", () => {
  it("reads from/to for known date keys only", () => {
    const params = {
      cf_due_from: "2026-07-01",
      cf_due_to: "2026-07-31",
      cf_other_from: "2026-01-01",
    };
    expect(parseCustomDateFilters(params, ["due"])).toEqual({
      due: { from: "2026-07-01", to: "2026-07-31" },
    });
  });

  it("keeps a one-sided range", () => {
    expect(parseCustomDateFilters({ cf_due_from: "2026-07-01" }, ["due"])).toEqual({
      due: { from: "2026-07-01" },
    });
  });

  it("drops non-ISO values and unknown keys", () => {
    expect(
      parseCustomDateFilters(
        { cf_due_from: "07/01/2026", cf_ghost_to: "2026-07-31" },
        ["due"],
      ),
    ).toEqual({});
  });
});

describe("applyFeatureFilters with customDates", () => {
  const rows = [
    feat("early", "2026-06-15"),
    feat("mid", "2026-07-15"),
    feat("late", "2026-08-15"),
    feat("undated", null),
  ];

  it("keeps items inside an inclusive range, excludes empties", () => {
    const filters: FeatureFilters = {
      customDates: { due: { from: "2026-07-01", to: "2026-07-31" } },
    };
    expect(applyFeatureFilters(rows, filters).map((f) => f.title)).toEqual(["mid"]);
  });

  it("supports an open-ended (from-only) range", () => {
    const filters: FeatureFilters = { customDates: { due: { from: "2026-07-01" } } };
    expect(applyFeatureFilters(rows, filters).map((f) => f.title)).toEqual([
      "mid",
      "late",
    ]);
  });

  it("treats range bounds as inclusive", () => {
    const filters: FeatureFilters = {
      customDates: { due: { from: "2026-07-15", to: "2026-07-15" } },
    };
    expect(applyFeatureFilters(rows, filters).map((f) => f.title)).toEqual(["mid"]);
  });
});

describe("customDates in filter bookkeeping", () => {
  const filters: FeatureFilters = {
    status: "backlog",
    customDates: { due: { from: "2026-07-01" } },
  };

  it("counts toward active filters", () => {
    expect(hasActiveFilters(filters)).toBe(true);
    expect(countActiveFilters(filters)).toBe(2);
    expect(hasActiveFilters({})).toBe(false);
  });

  it("round-trips through the query string", () => {
    const q = filtersToQuery(filters);
    expect(q).toContain("status=backlog");
    expect(q).toContain("cf_due_from=2026-07-01");
    expect(q).not.toContain("cf_due_to");
  });
});
