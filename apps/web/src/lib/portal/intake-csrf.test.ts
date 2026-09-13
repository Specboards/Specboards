import { describe, expect, it } from "vitest";

import {
  EXEMPT_PREFIXES,
  needsOriginCheck,
  originAllowed,
} from "@/lib/csrf-origin";

/**
 * The portal's public intake needs no CSRF exemption, asserted rather than
 * assumed.
 *
 * ── The card this closes was mostly dissolved, and this is what was left ───
 * It began as "widen the CSRF origin rule to accept portal subdomains", became
 * "exempt the portal's public intake from the cookie-CSRF origin check", and
 * then stopped being a change at all when the portal moved from
 * `{slug}.specboards.ai` to `/{org}/ideas`. Same origin as the app, so a POST
 * from a portal page carries an `Origin` that already matches, and
 * `originAllowed` accepts it. There is nothing to exempt.
 *
 * ── Why that still needs a test ────────────────────────────────────────────
 * Because this exact rule silently closed the request-access funnel in #460,
 * and `csrf-origin.test.ts` passed throughout that outage: it tested the
 * predicate, while the failure lived in the composition of middleware and
 * route. "It should be fine, it is same-origin" is precisely the reasoning that
 * was true then too.
 *
 * So these assert the composition for the intake path specifically, in both
 * directions, and the third case guards the fix from being "helpfully" undone.
 */

const INTAKE = "/api/portal/acme/ideas";
const APP = "https://app.specboards.ai";
const HOST = "app.specboards.ai";

describe("the portal intake is origin-checked, and passes", () => {
  it("is subject to the check at all", () => {
    // The half that an exemption would silently remove.
    expect(needsOriginCheck("POST", INTAKE)).toBe(true);
  });

  it("accepts a POST from the portal page's own origin", () => {
    // The real request: a visitor on https://app.specboards.ai/acme/ideas
    // submitting an idea. This is the case #460 got wrong for a different
    // endpoint.
    expect(originAllowed(APP, APP, HOST)).toBe(true);
  });

  it("still refuses a genuinely foreign origin", () => {
    // Same-origin convenience must not have become "the portal accepts
    // anything". Without this, the case above passes just as well against a
    // rule that returns true unconditionally.
    expect(originAllowed("https://evil.example", APP, HOST)).toBe(false);
    expect(originAllowed("null", APP, HOST)).toBe(false);
  });

  it("has no EXEMPT_PREFIXES entry, and must not gain one", () => {
    // Not tidiness. This endpoint reads no session, so the origin check costs
    // it nothing and is one more thing keeping a cross-site POST off it. An
    // exemption added "for safety" would be pure added surface, and it is the
    // obvious thing for somebody to reach for the first time they see a 403
    // here from a misconfigured local setup.
    const exempted = EXEMPT_PREFIXES.filter((p) => INTAKE.startsWith(p));
    expect(
      exempted,
      "the portal intake must stay origin-checked; see #460 and #463",
    ).toEqual([]);
  });

  it("does not exempt the portal's read pages either", () => {
    // Guards the guard: `needsOriginCheck` only applies to /api/ paths and
    // mutating methods, so a GET of the portal page was never in scope. Stated
    // so that a future reader does not add an exemption for the page tree
    // believing it is needed.
    expect(needsOriginCheck("GET", "/acme/ideas")).toBe(false);
    expect(needsOriginCheck("POST", "/acme/ideas")).toBe(false);
  });
});
