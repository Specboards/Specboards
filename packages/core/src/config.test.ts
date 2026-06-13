import { describe, expect, it } from "vitest";

import { parseRepoConfigYaml, safeParseRepoConfig } from "./config.js";

describe("parseRepoConfigYaml", () => {
  it("parses a config.yml with globs and custom fields", () => {
    const raw = [
      "version: 1",
      "specGlobs:",
      '  - "specs/**/spec.md"',
      "writeMode: pr",
      "fields:",
      "  - key: effort",
      "    label: Effort",
      "    type: select",
      '    options: ["S", "M", "L"]',
    ].join("\n");

    const config = parseRepoConfigYaml(raw);
    expect(config.specGlobs).toEqual(["specs/**/spec.md"]);
    expect(config.writeMode).toBe("pr");
    expect(config.fields).toEqual([
      { key: "effort", label: "Effort", type: "select", options: ["S", "M", "L"] },
    ]);
  });

  it("applies defaults when optional keys are omitted", () => {
    const config = parseRepoConfigYaml("version: 1");
    expect(config.specGlobs).toEqual(["specs/**/spec.md"]);
    expect(config.writeMode).toBe("pr");
    expect(config.fields).toEqual([]);
  });

  it("throws on an invalid field type", () => {
    const raw = "version: 1\nfields:\n  - key: x\n    label: X\n    type: bogus";
    expect(() => parseRepoConfigYaml(raw)).toThrow();
  });
});

describe("safeParseRepoConfig", () => {
  it("returns null for malformed input instead of throwing", () => {
    expect(safeParseRepoConfig(null)).toBeNull();
    expect(safeParseRepoConfig({ version: 2 })).toBeNull();
  });

  it("returns the parsed config for a valid object", () => {
    const config = safeParseRepoConfig({ version: 1, specGlobs: ["a/**/spec.md"] });
    expect(config?.specGlobs).toEqual(["a/**/spec.md"]);
  });
});
