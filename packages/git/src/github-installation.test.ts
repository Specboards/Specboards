import { describe, expect, it } from "vitest";

import { hasGithubInstallation, RepoNotConnectedError } from "./github";

/**
 * Telling a GitHub connection from a repository row that never had one.
 *
 * Not every row in `repositories` is a GitHub connection. A workspace seeded
 * with the sample board gets one so the sample specs have somewhere to hang,
 * and its installation id is the literal string "sample".
 *
 * Before this predicate existed that placeholder went through `Number(...)`
 * and reached octokit as `NaN`, which answered:
 *
 *     specboard/getting-started: [@octokit/auth-app] installationId option is
 *     required for installation authentication.
 *
 * Reported from a real self-host install. It is a true sentence about
 * octokit's arguments and useless to the person reading it: they had just
 * connected GitHub, it had worked, and here was an error naming a repository
 * they never connected.
 */

describe("hasGithubInstallation", () => {
  it("accepts a real installation id", () => {
    expect(hasGithubInstallation("12345678")).toBe(true);
  });

  it("rejects the sample board's placeholder", () => {
    // The exact value `sample-data.ts` writes. Spelled out rather than
    // imported, so changing the seed cannot quietly make this test vacuous.
    expect(hasGithubInstallation("sample")).toBe(false);
  });

  it("rejects the values that reach octokit as NaN or nonsense", () => {
    for (const bad of ["", "  ", "abc", "12.5", "-1", "0", "1e3", "0x10"]) {
      expect(hasGithubInstallation(bad), bad).toBe(false);
    }
  });

  it("rejects a missing id rather than throwing on it", () => {
    // Callers filter lists with this, so it has to tolerate a null column
    // without needing a guard at every call site.
    expect(hasGithubInstallation(null)).toBe(false);
  });

  it("does not accept a number with a plausible-looking suffix", () => {
    // `Number("123abc")` is NaN, but a looser check such as parseInt would
    // return 123 and authenticate against somebody else's installation.
    expect(hasGithubInstallation("123abc")).toBe(false);
  });
});

describe("RepoNotConnectedError", () => {
  it("names the repository and says why, rather than naming octokit", () => {
    const err = new RepoNotConnectedError("specboard/getting-started");
    expect(err.message).toContain("specboard/getting-started");
    expect(err.message).toMatch(/not connected to a GitHub installation/);
    // The sentence somebody needs in order to stop worrying about it.
    expect(err.message).toMatch(/sample board/i);
    expect(err.message).not.toMatch(/octokit/i);
  });
});
