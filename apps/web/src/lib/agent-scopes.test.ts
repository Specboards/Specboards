import { describe, expect, it } from "vitest";

import {
  GROUPED_RESOURCES,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  levelsFromScopes,
  scopesFromLevels,
} from "./agent-scopes";
import { SCOPE_RESOURCES, parseApiScopes } from "./api-scopes";

/**
 * The agent scope picker has to stay in step with the scope vocabulary. A
 * resource that exists but is not in a group is one an owner can never grant
 * from Settings, and nothing else would catch that: the API would happily
 * accept the scope, there just would be no way to ask for it.
 */

describe("scope groups", () => {
  it("covers every scope resource exactly once", () => {
    expect([...GROUPED_RESOURCES].sort()).toEqual([...SCOPE_RESOURCES].sort());
    expect(new Set(GROUPED_RESOURCES).size).toBe(GROUPED_RESOURCES.length);
  });

  it("gives every resource a label", () => {
    for (const group of SCOPE_GROUPS) {
      for (const r of group.resources) {
        expect(r.label.trim(), r.resource).not.toBe("");
      }
    }
  });
});

describe("scopesFromLevels", () => {
  it("emits scopes the API accepts", () => {
    const scopes = scopesFromLevels({ features: "write", statuses: "read" });
    expect(scopes).toEqual(["features:write", "statuses:read"]);
    // The round trip that matters: whatever the UI builds must survive the
    // validator the create endpoint runs it through.
    expect(parseApiScopes(scopes)).toEqual(scopes);
  });

  it("drops `none` rather than encoding it", () => {
    expect(scopesFromLevels({ features: "none", specs: "read" })).toEqual([
      "specs:read",
    ]);
  });

  it("returns an empty list when nothing is selected", () => {
    // Empty means UNRESTRICTED at the key layer, which is why the card refuses
    // to submit it. Asserted here so that meaning stays deliberate.
    expect(scopesFromLevels({})).toEqual([]);
  });
});

describe("levelsFromScopes", () => {
  it("round-trips a selection", () => {
    const levels = { features: "write", docs: "read" } as const;
    expect(levelsFromScopes(scopesFromLevels(levels))).toEqual(levels);
  });

  it("ignores scopes it does not recognise", () => {
    expect(levelsFromScopes(["*", "nonsense:write", "features:read"])).toEqual({
      features: "read",
    });
  });
});

describe("presets", () => {
  it("produce valid, non-empty scope sets", () => {
    for (const preset of SCOPE_PRESETS) {
      const scopes = scopesFromLevels(preset.levels());
      expect(scopes.length, preset.id).toBeGreaterThan(0);
      expect(parseApiScopes(scopes), preset.id).toEqual(scopes);
    }
  });

  it("keeps read-only free of any write grant", () => {
    const readOnly = SCOPE_PRESETS.find((p) => p.id === "read-only")!;
    for (const scope of scopesFromLevels(readOnly.levels())) {
      expect(scope.endsWith(":read"), scope).toBe(true);
    }
  });

  it("lets the authoring preset write specs but not administer the org", () => {
    const author = SCOPE_PRESETS.find((p) => p.id === "author")!;
    const scopes = scopesFromLevels(author.levels());
    expect(scopes).toContain("specs:write");
    expect(scopes).toContain("features:write");
    expect(scopes).toContain("org:read");
    expect(scopes).not.toContain("org:write");
    expect(scopes).not.toContain("webhooks:write");
    expect(scopes).not.toContain("repositories:write");
  });
});
