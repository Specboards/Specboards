import { describe, expect, it } from "vitest";

import { compareByCustomField, parseSortMode } from "./feature-helpers";
import type { CustomFieldValue, FeatureRecord } from "./store/types";

/** Minimal feature stub: the comparator only reads `title` and `customFields`. */
function feat(
  title: string,
  key: string,
  value: CustomFieldValue,
): FeatureRecord {
  return { title, customFields: { [key]: value } } as unknown as FeatureRecord;
}

function ordered(features: FeatureRecord[], cmp: (a: FeatureRecord, b: FeatureRecord) => number) {
  return [...features].sort(cmp).map((f) => f.title);
}

describe("compareByCustomField", () => {
  it("sorts date values ascending, empties last", () => {
    const cmp = compareByCustomField("due", "date");
    const rows = [
      feat("later", "due", "2026-08-01"),
      feat("none", "due", null),
      feat("soon", "due", "2026-07-24"),
      feat("blank", "due", ""),
    ];
    expect(ordered(rows, cmp)).toEqual(["soon", "later", "blank", "none"]);
  });

  it("sorts number values numerically, not lexically", () => {
    const cmp = compareByCustomField("size", "number");
    const rows = [
      feat("nine", "size", 9),
      feat("ten", "size", 10),
      feat("two", "size", 2),
    ];
    // Lexical order would put "10" before "2"; numeric keeps 2 < 9 < 10.
    expect(ordered(rows, cmp)).toEqual(["two", "nine", "ten"]);
  });

  it("coerces numeric strings for number fields", () => {
    const cmp = compareByCustomField("size", "number");
    const rows = [feat("b", "size", "10"), feat("a", "size", "2")];
    expect(ordered(rows, cmp)).toEqual(["a", "b"]);
  });

  it("sorts text values case-insensitively via localeCompare", () => {
    const cmp = compareByCustomField("owner", "text");
    const rows = [
      feat("c", "owner", "charlie"),
      feat("a", "owner", "Alice"),
      feat("b", "owner", "bob"),
    ];
    expect(ordered(rows, cmp)).toEqual(["a", "b", "c"]);
  });

  it("breaks ties on equal values by title", () => {
    const cmp = compareByCustomField("due", "date");
    const rows = [
      feat("zeta", "due", "2026-07-24"),
      feat("alpha", "due", "2026-07-24"),
    ];
    expect(ordered(rows, cmp)).toEqual(["alpha", "zeta"]);
  });

  it("orders two empties by title", () => {
    const cmp = compareByCustomField("due", "date");
    const rows = [feat("beta", "due", null), feat("alpha", "due", null)];
    expect(ordered(rows, cmp)).toEqual(["alpha", "beta"]);
  });
});

describe("parseSortMode", () => {
  it("returns the built-in modes", () => {
    expect(parseSortMode(undefined)).toBe("default");
    expect(parseSortMode("rice")).toBe("rice");
    expect(parseSortMode("bogus")).toBe("default");
  });

  it("honors a cf: mode only when the key is sortable", () => {
    expect(parseSortMode("cf:due", ["due", "size"])).toBe("cf:due");
    // Key not in the sortable set (e.g. removed or a multiselect) → default.
    expect(parseSortMode("cf:due", ["size"])).toBe("default");
    expect(parseSortMode("cf:due", [])).toBe("default");
  });

  it("reads the first value of a repeated param", () => {
    expect(parseSortMode(["cf:due", "rice"], ["due"])).toBe("cf:due");
  });
});
