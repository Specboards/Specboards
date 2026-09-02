import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthRequiredError } from "@/lib/api-client/request";

import { redirectOnAuthExpiry, signInHref } from "./auth-expiry";

/**
 * The one browser behaviour for an expired session.
 *
 * Worth testing rather than reading, because the two things that were wrong
 * across the eighty hand-written copies this replaces are both invisible at a
 * glance: whether the current path survives the round trip, and whether an
 * error that is not an expired session gets quietly swallowed on the way past.
 */

/** The helper reads the live path; these tests run under Node, which has none. */
function atPath(pathname: string) {
  vi.stubGlobal("window", { location: { pathname } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function router() {
  return { push: vi.fn() } as unknown as Parameters<
    typeof redirectOnAuthExpiry
  >[1];
}

describe("signInHref", () => {
  it("carries the path so sign-in can return the user to it", () => {
    expect(signInHref("/acme/default/backlog")).toBe(
      "/sign-in?from=%2Facme%2Fdefault%2Fbacklog",
    );
  });

  it("encodes a path that would otherwise break out of the query", () => {
    expect(signInHref("/a&b=c")).toBe("/sign-in?from=%2Fa%26b%3Dc");
  });
});

describe("redirectOnAuthExpiry", () => {
  it("redirects on an expired session and says it handled it", () => {
    atPath("/acme/default/backlog/SPEC-1");
    const r = router();
    expect(redirectOnAuthExpiry(new AuthRequiredError(), r)).toBe(true);
    expect(r.push).toHaveBeenCalledWith(
      "/sign-in?from=%2Facme%2Fdefault%2Fbacklog%2FSPEC-1",
    );
  });

  it("leaves any other error alone for the caller to report", () => {
    // The important half. A guard that swallowed ordinary failures would turn
    // every save error into a silent no-op, which is worse than the bug this
    // replaces.
    const r = router();
    expect(redirectOnAuthExpiry(new Error("Save failed."), r)).toBe(false);
    expect(r.push).not.toHaveBeenCalled();
  });

  it("treats a non-error value as not an expired session", () => {
    const r = router();
    expect(redirectOnAuthExpiry("nope", r)).toBe(false);
    expect(r.push).not.toHaveBeenCalled();
  });
});
