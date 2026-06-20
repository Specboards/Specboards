import { describe, expect, it } from "vitest";

import {
  ORG_SLUG_MAX,
  isReservedOrgSlug,
  slugifyOrg,
} from "./org-slug.js";

describe("slugifyOrg", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyOrg("Acme Inc.")).toBe("acme-inc");
    expect(slugifyOrg("Studio Palouse")).toBe("studio-palouse");
  });

  it("collapses runs of non-alphanumerics into a single hyphen", () => {
    expect(slugifyOrg("Foo   ---  Bar!!!Baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing separators", () => {
    expect(slugifyOrg("  Acme  ")).toBe("acme");
    expect(slugifyOrg("-Acme-")).toBe("acme");
    expect(slugifyOrg("!!!Acme!!!")).toBe("acme");
  });

  it("returns empty when nothing usable remains", () => {
    expect(slugifyOrg("")).toBe("");
    expect(slugifyOrg("   ")).toBe("");
    expect(slugifyOrg("日本語")).toBe("");
    expect(slugifyOrg("!@#$%")).toBe("");
  });

  it("caps length and never leaves a trailing hyphen after slicing", () => {
    const long = "a".repeat(60) + " " + "b".repeat(60);
    const slug = slugifyOrg(long);
    expect(slug.length).toBeLessThanOrEqual(ORG_SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
    // A hyphen landing exactly on the cap boundary is trimmed.
    expect(slugifyOrg("a".repeat(ORG_SLUG_MAX) + " tail")).toBe("a".repeat(ORG_SLUG_MAX));
  });

  it("preserves existing hyphens and digits", () => {
    expect(slugifyOrg("web-3 platform")).toBe("web-3-platform");
  });
});

describe("isReservedOrgSlug", () => {
  it("flags top-level routes and framework segments", () => {
    for (const reserved of ["api", "setup", "sign-in", "sign-up", "_next", "local"]) {
      expect(isReservedOrgSlug(reserved)).toBe(true);
    }
  });

  it("allows ordinary org slugs", () => {
    for (const ok of ["acme", "palouse", "nintex", "settings-co", "apidev"]) {
      expect(isReservedOrgSlug(ok)).toBe(false);
    }
  });
});
