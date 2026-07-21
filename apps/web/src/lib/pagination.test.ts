import { describe, expect, it } from "vitest";

import {
  InvalidPageError,
  encodeCursor,
  paginate,
  parsePageRequest,
  type Page,
} from "./pagination";

const url = (qs: string) => new URL(`https://x/api/v1/features${qs}`);
const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const key = (i: { id: string }) => i.id;

describe("parsePageRequest", () => {
  it("returns no paging when limit is absent", () => {
    expect(parsePageRequest(url(""))).toEqual({ limit: null, after: null });
  });

  it("parses a valid limit and decodes the cursor", () => {
    const cursor = encodeCursor("b");
    expect(parsePageRequest(url(`?limit=2&cursor=${cursor}`))).toEqual({
      limit: 2,
      after: "b",
    });
  });

  it("rejects an out-of-range or non-integer limit", () => {
    expect(() => parsePageRequest(url("?limit=0"))).toThrow(InvalidPageError);
    expect(() => parsePageRequest(url("?limit=201"))).toThrow(InvalidPageError);
    expect(() => parsePageRequest(url("?limit=2.5"))).toThrow(InvalidPageError);
    expect(() => parsePageRequest(url("?limit=abc"))).toThrow(InvalidPageError);
  });
});

describe("paginate", () => {
  it("returns everything with a null cursor when limit is null", () => {
    const page = paginate(items, key, { limit: null, after: null });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("returns the first page and a cursor to resume", () => {
    const page = paginate(items, key, { limit: 2, after: null });
    expect(page.items.map(key)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe(encodeCursor("b"));
  });

  it("resumes after the cursor and preserves input order", () => {
    const page = paginate(items, key, { limit: 2, after: "b" });
    expect(page.items.map(key)).toEqual(["c", "d"]);
    expect(page.nextCursor).toBe(encodeCursor("d"));
  });

  it("has a null cursor on the last page", () => {
    const page = paginate(items, key, { limit: 2, after: "d" });
    expect(page.items.map(key)).toEqual(["e"]);
    expect(page.nextCursor).toBeNull();
  });

  it("does NOT re-sort: a non-alphabetical order is preserved", () => {
    const ordered = [{ id: "e" }, { id: "c" }, { id: "a" }, { id: "b" }];
    const page = paginate(ordered, key, { limit: 2, after: null });
    expect(page.items.map(key)).toEqual(["e", "c"]);
    expect(paginate(ordered, key, { limit: 2, after: "c" }).items.map(key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("yields an empty final page for an unknown cursor", () => {
    const page = paginate(items, key, { limit: 2, after: "zzz" });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("round-trips a full walk without gaps or repeats", () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Page<{ id: string }> = paginate(items, key, { limit: 2, after });
      seen.push(...page.items.map(key));
      if (!page.nextCursor) break;
      after = Buffer.from(page.nextCursor, "base64url").toString("utf8");
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  });
});
