import { describe, expect, it } from "vitest";

import {
  ORG_SLUG_MAX,
  isReservedOrgSlug,
  RESERVED_ORG_SLUGS,
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

  it("flags the hosts this deployment already serves", () => {
    // The dimension that arrived with the public portal, and the dangerous one.
    // A slug is a hostname on a wildcard-covered zone, so a workspace slugged
    // `app` would claim app.specboards.ai: not a clash of names, but a customer
    // handed the production application.
    for (const reserved of ["app", "test", "www", "admin", "portal"]) {
      expect(isReservedOrgSlug(reserved), reserved).toBe(true);
    }
  });

  it("flags the hostnames mail depends on", () => {
    // Sending reputation is deployment-wide rather than per tenant, so a
    // customer's portal answering on one of these is a deliverability problem
    // nobody would trace back to a workspace name.
    for (const reserved of ["mail", "smtp", "mx", "autodiscover", "bounces"]) {
      expect(isReservedOrgSlug(reserved), reserved).toBe(true);
    }
  });

  it("allows ordinary org slugs", () => {
    for (const ok of ["acme", "palouse", "nintex", "settings-co", "apidev"]) {
      expect(isReservedOrgSlug(ok)).toBe(false);
    }
  });

  it("does not reserve a name merely for containing a reserved one", () => {
    // The check is equality, not a substring or prefix match, and it should
    // stay that way: over-reserving costs real customers real names, and
    // `mailchimp.specboards.ai` collides with nothing.
    for (const ok of ["mailchimp", "appleton", "testing-co", "wwwise", "devon"]) {
      expect(isReservedOrgSlug(ok), ok).toBe(false);
    }
  });

  it("reserves only slugs that slugifyOrg could actually produce", () => {
    // A reservation that no name can slugify to is dead weight, and worse, it
    // reads as protection that is not there. `favicon.ico` and `_next` are the
    // deliberate exceptions: they are route/framework segments a request can
    // name directly, not names a person would type into the setup form.
    const unreachable = [...RESERVED_ORG_SLUGS].filter(
      (s) => slugifyOrg(s) !== s,
    );
    expect(unreachable.sort()).toEqual(["_next", "favicon.ico"]);
  });
});
