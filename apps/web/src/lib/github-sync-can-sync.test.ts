import { afterEach, describe, expect, it } from "vitest";

import { canSyncRepo } from "./github-sync";

/**
 * Which repository rows the scan and the import will act on.
 *
 * This exists because the first version of the sample-repo fix asked the
 * question directly at the call sites ("does this row name a real GitHub
 * installation") and that is not the same question. Under E2E the fake repo
 * client stands in for every repository regardless of its installation id, so
 * a caller filtering on the id skipped every repository the suite had seeded
 * and fourteen end-to-end specs went red at once.
 *
 * The rule these pin is the one that was broken: `canSyncRepo` has to agree
 * with `resolveRepoClient` about whether a repository can be served, because
 * they are two halves of the same decision.
 */

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

function e2eOn(): void {
  process.env.SPECBOARDS_E2E = "1";
  // isE2E only honours the flag on a localhost origin.
  process.env.APP_URL = "http://localhost:3100";
}

function e2eOff(): void {
  delete process.env.SPECBOARDS_E2E;
  process.env.APP_URL = "https://app.specboard.ai";
}

describe("canSyncRepo", () => {
  it("skips a sample repository, which has no installation behind it", () => {
    e2eOff();
    // "sample" rather than null because the column is NOT NULL: a row with no
    // installation behind it has to carry some sentinel, which is the whole
    // reason a sample repository is indistinguishable from a real one at a
    // glance.
    expect(canSyncRepo({ githubInstallationId: "sample" })).toBe(false);
    expect(canSyncRepo({ githubInstallationId: "" })).toBe(false);
  });

  it("takes a genuinely connected repository", () => {
    e2eOff();
    expect(canSyncRepo({ githubInstallationId: "12345678" })).toBe(true);
  });

  it("takes every repository under E2E, where the fake stands in for all of them", () => {
    // The regression: the E2E harness seeds rows with "e2e-installation", and
    // filtering those out leaves the suite with nothing to scan or import.
    e2eOn();
    expect(canSyncRepo({ githubInstallationId: "e2e-installation" })).toBe(true);
  });
});
