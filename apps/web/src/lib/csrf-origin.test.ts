import { describe, expect, it } from "vitest";

import { needsOriginCheck, originAllowed } from "./csrf-origin";

/**
 * F26. Cross-site protection for the mutating `/api/v1` surface rested entirely
 * on Better Auth's default `SameSite=Lax` cookie. That default is real
 * (confirmed in better-auth 1.6.26's `dist/cookies/index.mjs`, with no override
 * anywhere in this codebase), and it does block the attack today. What it does
 * not do is survive somebody setting `sameSite: "none"` to embed the app on
 * another subdomain, which would not obviously read as a security change.
 *
 * These cases pin the rule, and in particular pin the two decisions that look
 * like holes until you know why: an absent `Origin` is allowed, and a handful of
 * paths are exempt.
 */

const APP = "https://app.specboards.ai";
const HOST = "app.specboards.ai";

describe("which requests are checked", () => {
  it("checks mutating API requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) {
      expect(needsOriginCheck(method, "/api/v1/features"), method).toBe(true);
    }
  });

  it("leaves reads alone", () => {
    // A GET changes nothing, and CSRF is about state change. Checking them
    // would break ordinary cross-origin reads for no benefit.
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(needsOriginCheck(method, "/api/v1/features"), method).toBe(false);
    }
  });

  it("leaves pages alone", () => {
    // Server actions and page loads are not this rule's business; it is scoped
    // to the API surface the finding names.
    expect(needsOriginCheck("POST", "/some-org/settings")).toBe(false);
  });

  it("exempts the paths that authenticate without a cookie", () => {
    // Each for its own reason, and each spelled out in the module: Better Auth
    // runs its own CSRF handling and serves browser-based OAuth clients;
    // webhooks are GitHub, authenticated by HMAC and sending no Origin; MCP
    // uses a bearer token or API key, so there is no ambient authority to ride.
    expect(needsOriginCheck("POST", "/api/auth/sign-in")).toBe(false);
    expect(needsOriginCheck("POST", "/api/webhooks/github")).toBe(false);
    expect(needsOriginCheck("POST", "/api/mcp")).toBe(false);
    // But not something that merely starts similarly.
    expect(needsOriginCheck("POST", "/api/v1/webhooks/abc")).toBe(true);
  });
});

describe("which origins are allowed", () => {
  it("allows our own origin", () => {
    expect(originAllowed(APP, APP, HOST)).toBe(true);
    // Port and scheme differences on the same host are fine: the host is what
    // identifies the deployment, and a scheme mismatch is an HTTPS problem
    // rather than a CSRF one.
    expect(originAllowed("https://app.specboards.ai:443", APP, HOST)).toBe(true);
  });

  it("refuses another site", () => {
    expect(originAllowed("https://evil.example", APP, HOST)).toBe(false);
    // A subdomain is a different host, and the whole scenario this guards is
    // cross-subdomain embedding.
    expect(originAllowed("https://evil.app.specboards.ai", APP, HOST)).toBe(false);
    // A prefix match would pass a lookalike; this is not a prefix match.
    expect(originAllowed("https://app.specboards.ai.evil.example", APP, HOST)).toBe(false);
  });

  it("allows a request with no Origin at all", () => {
    // The decision that looks like a hole. Browsers have sent Origin on every
    // non-GET request, form submissions included, since around 2020. A missing
    // Origin therefore means the caller is not a browser: the CLI, an MCP
    // client, CI, curl. Those authenticate with an API key rather than a
    // cookie, so they cannot be ridden cross-site, and requiring the header
    // would break all of them to defend against a request shape that does not
    // exist.
    expect(originAllowed(null, APP, HOST)).toBe(true);
  });

  it("refuses the literal null origin", () => {
    // A sandboxed iframe or a redirected POST sends this. It is never ours, and
    // it is not the same as the header being absent.
    expect(originAllowed("null", APP, HOST)).toBe(false);
  });

  it("refuses an unparseable Origin", () => {
    expect(originAllowed("not a url", APP, HOST)).toBe(false);
  });

  it("falls back to the request host when APP_URL is not configured", () => {
    // Weaker, because a hostile proxy controls the host header, but it is the
    // same trust model the rest of the app already uses without APP_URL, and it
    // still refuses an origin that differs from the host the browser believes
    // it is talking to.
    expect(originAllowed(APP, null, HOST)).toBe(true);
    expect(originAllowed("https://evil.example", null, HOST)).toBe(false);
    // Nothing to compare against at all: refuse rather than wave it through.
    expect(originAllowed(APP, null, null)).toBe(false);
  });

  it("falls back to the host when APP_URL is malformed rather than refusing everything", () => {
    // A broken APP_URL is a misconfiguration the boot guard already reports.
    // Failing every write on top of that turns a warning into an outage.
    expect(originAllowed(APP, "not a url", HOST)).toBe(true);
    expect(originAllowed("https://evil.example", "not a url", HOST)).toBe(false);
  });
});
