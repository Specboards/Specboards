import { describe, expect, it } from "vitest";

import { parseIdSet, serializeIdSet } from "./use-stored-id-set";

/**
 * Reading a remembered set of collapsed rows out of localStorage.
 *
 * This runs during render, on every roadmap and backlog table, against a value
 * the app does not control: another tab can write it, a browser can truncate
 * it, and the key can outlive the shape it was written in. A throw here is a
 * blank page where a board should be, so every malformed case has to come back
 * as "no preference recorded" instead.
 */
describe("parseIdSet", () => {
  const fallback = new Set(["default-id"]);

  it("reads back what it wrote", () => {
    const ids = new Set(["a", "b"]);
    expect(parseIdSet(serializeIdSet(ids), fallback)).toEqual(ids);
  });

  it("falls back when nothing is stored", () => {
    // The distinction that matters: no preference is not the same as an empty
    // preference. The ladder collapses parent rows by default, and treating a
    // missing key as "expand everything" would throw that away.
    expect(parseIdSet(null, fallback)).toBe(fallback);
    expect(parseIdSet("", fallback)).toBe(fallback);
  });

  it("keeps an explicitly empty set, which is a real preference", () => {
    expect(parseIdSet("[]", fallback)).toEqual(new Set());
  });

  it("falls back on a truncated write rather than throwing", () => {
    expect(parseIdSet('["a", "b"', fallback)).toBe(fallback);
  });

  it("falls back on a value that is not a list of ids", () => {
    expect(parseIdSet('{"a":true}', fallback)).toBe(fallback);
    expect(parseIdSet('"a"', fallback)).toBe(fallback);
    expect(parseIdSet("42", fallback)).toBe(fallback);
  });

  it("drops non-string entries instead of trusting the whole array", () => {
    // A half-migrated value from an older shape should lose the entries it
    // cannot use, not the ones it can.
    expect(parseIdSet('["a", 3, null, "b"]', fallback)).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("round-trips in insertion order, so the stored text is stable", () => {
    // A set that serializes differently on each write would churn localStorage
    // and, through the storage event, every other tab.
    expect(serializeIdSet(new Set(["b", "a"]))).toBe('["b","a"]');
  });
});
