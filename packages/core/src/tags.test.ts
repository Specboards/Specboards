import { describe, expect, it } from "vitest";

import {
  normalizeTagName,
  resolveTagNames,
  tagKey,
  tagNameError,
} from "./tags.js";

describe("normalizeTagName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeTagName("  area:web  ")).toBe("area:web");
    expect(normalizeTagName("needs   design")).toBe("needs design");
  });

  it("preserves casing", () => {
    // Matching is case-insensitive, but which spelling a workspace displays is
    // its own choice and must survive the round trip.
    expect(normalizeTagName("Area:Web")).toBe("Area:Web");
  });
});

describe("tagKey", () => {
  it("folds the spellings that used to become separate tags", () => {
    expect(tagKey("area:web")).toBe(tagKey("Area:Web"));
    expect(tagKey("area:web")).toBe(tagKey("  AREA:WEB "));
  });
});

describe("tagNameError", () => {
  it("rejects an empty or whitespace-only name", () => {
    expect(tagNameError("")).toBe("Tag name is required.");
    expect(tagNameError("   ")).toBe("Tag name is required.");
  });

  it("rejects a name containing a comma", () => {
    // The old editor split on commas, so a comma in a name would split into
    // two tags anywhere that format survives.
    expect(tagNameError("a,b")).toMatch(/comma/);
  });

  it("rejects a name over the length limit", () => {
    expect(tagNameError("x".repeat(65))).toMatch(/64 characters/);
    expect(tagNameError("x".repeat(64))).toBeNull();
  });

  it("accepts the shapes this workspace already uses", () => {
    for (const name of ["area:web", "tier-1", "on-prem", "gh-31", "tech debt"]) {
      expect(tagNameError(name)).toBeNull();
    }
  });
});

describe("resolveTagNames", () => {
  const registry = [{ name: "area:web" }, { name: "tier-1" }];

  it("canonicalizes a differently-cased name to the registry's spelling", () => {
    expect(resolveTagNames(["Area:Web"], registry)).toEqual({
      names: ["area:web"],
      missing: [],
    });
  });

  it("reports an unknown name as one to create, not as an error", () => {
    // Adding a tag from a card is a requirement, and refusing an unknown name
    // would break every agent that writes tags through the API or MCP.
    expect(resolveTagNames(["area:web", "new-thing"], registry)).toEqual({
      names: ["area:web", "new-thing"],
      missing: ["new-thing"],
    });
  });

  it("collapses names that differ only by case or spacing", () => {
    expect(resolveTagNames(["area:web", "AREA:WEB", " area:web "], registry))
      .toEqual({ names: ["area:web"], missing: [] });
  });

  it("collapses duplicates among unknown names too", () => {
    // Otherwise the caller would try to create the same registry row twice.
    expect(resolveTagNames(["New", "new"], registry)).toEqual({
      names: ["New"],
      missing: ["New"],
    });
  });

  it("keeps the order the caller gave", () => {
    expect(resolveTagNames(["tier-1", "area:web"], registry).names).toEqual([
      "tier-1",
      "area:web",
    ]);
  });

  it("drops empty and whitespace-only entries", () => {
    // A trailing comma in the old editor produced exactly these.
    expect(resolveTagNames(["area:web", "", "   "], registry)).toEqual({
      names: ["area:web"],
      missing: [],
    });
  });

  it("treats an empty registry as everything being new", () => {
    expect(resolveTagNames(["a", "b"], [])).toEqual({
      names: ["a", "b"],
      missing: ["a", "b"],
    });
  });
});
