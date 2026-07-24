import { describe, expect, it } from "vitest";

import type { PropertyDef } from "@specboards/core";

import { assertCustomFieldTypes, InvalidPatchError } from "./features-service";

/** A property definition stub; only `key` and `type` matter to the validator. */
function prop(key: string, type: PropertyDef["type"]): PropertyDef {
  return { id: key, key, label: key, type, options: [], levels: null, position: 0 };
}

const props = [prop("due", "date"), prop("size", "number"), prop("owner", "text")];

describe("assertCustomFieldTypes", () => {
  it("accepts a valid ISO date", () => {
    expect(() => assertCustomFieldTypes({ due: "2026-07-24" }, props)).not.toThrow();
  });

  it("accepts null to clear a date field", () => {
    expect(() => assertCustomFieldTypes({ due: null }, props)).not.toThrow();
  });

  it("rejects a non-ISO date string", () => {
    expect(() => assertCustomFieldTypes({ due: "07/24/2026" }, props)).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects an impossible calendar date", () => {
    expect(() => assertCustomFieldTypes({ due: "2026-13-45" }, props)).toThrow(
      InvalidPatchError,
    );
    expect(() => assertCustomFieldTypes({ due: "2026-02-30" }, props)).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects a non-string value for a date field", () => {
    expect(() => assertCustomFieldTypes({ due: 20260724 }, props)).toThrow(
      InvalidPatchError,
    );
  });

  it("ignores non-date fields and unknown keys", () => {
    expect(() =>
      assertCustomFieldTypes(
        { size: "not a number", owner: "anyone", mystery: "x" },
        props,
      ),
    ).not.toThrow();
  });
});
