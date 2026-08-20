import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { clientIp, rateLimitKey, trustsForwardedFor } from "./client-ip";

/**
 * Which client-IP headers we believe, and when.
 *
 * `x-forwarded-for` is appended to rather than overwritten by most proxies, and
 * on a deployment with no normalising proxy it is whatever the client typed.
 * Trusting it there lets a caller mint a fresh rate-limit bucket per request by
 * varying one header: a limit that reads as per-IP while providing none.
 *
 * `fly-client-ip` has exactly the same problem OFF Fly, which is what F23 found:
 * it was trusted unconditionally while `x-forwarded-for` needed an opt-in. On
 * Fly the edge overwrites it and it is authoritative; anywhere else nothing
 * does. So it is now gated on `FLY_APP_NAME`, which the Fly runtime sets and a
 * request cannot, and these cases set it explicitly rather than inheriting it.
 */

const saved: { trust?: string; fly?: string } = {};

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/access-request", {
    method: "POST",
    headers,
  });
}

describe("clientIp", () => {
  beforeAll(() => {
    saved.trust = process.env.SPECBOARDS_TRUST_PROXY;
    saved.fly = process.env.FLY_APP_NAME;
  });

  afterEach(() => {
    if (saved.trust === undefined) delete process.env.SPECBOARDS_TRUST_PROXY;
    else process.env.SPECBOARDS_TRUST_PROXY = saved.trust;
    if (saved.fly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = saved.fly;
  });

  it("trusts fly-client-ip on Fly, where the edge overwrites it", () => {
    delete process.env.SPECBOARDS_TRUST_PROXY;
    process.env.FLY_APP_NAME = "specboard-test";
    expect(clientIp(req({ "fly-client-ip": "203.0.113.7" }))).toEqual({
      known: true,
      ip: "203.0.113.7",
      source: "fly-client-ip",
    });
  });

  it("ignores fly-client-ip off Fly, where nothing overwrites it", () => {
    // F23. This header used to be believed everywhere, so a self-host outside
    // Fly gave every caller a fresh rate-limit bucket per request by varying
    // one header. Unknown is the honest answer, and `rateLimitKey` turns it
    // into one shared bucket: blunter, and not forgeable.
    delete process.env.SPECBOARDS_TRUST_PROXY;
    delete process.env.FLY_APP_NAME;
    expect(clientIp(req({ "fly-client-ip": "203.0.113.7" }))).toEqual({ known: false });
    expect(rateLimitKey(req({ "fly-client-ip": "203.0.113.7" }), "access-request")).toBe(
      "access-request:unknown-client",
    );
  });

  it("does not let SPECBOARDS_TRUST_PROXY re-enable fly-client-ip off Fly", () => {
    // The flag is about `x-forwarded-for`, which is the documented route for a
    // normalising proxy. Letting it also vouch for a header nothing on that
    // deployment writes would put the bug back behind a different name.
    process.env.SPECBOARDS_TRUST_PROXY = "1";
    delete process.env.FLY_APP_NAME;
    expect(clientIp(req({ "fly-client-ip": "203.0.113.7" }))).toEqual({ known: false });
  });

  it("prefers fly-client-ip over a client-supplied x-forwarded-for", () => {
    process.env.FLY_APP_NAME = "specboard-test";
    // The spoofing case: a caller sets x-forwarded-for hoping to be counted as
    // someone else. Fly's header wins.
    expect(
      clientIp(
        req({ "fly-client-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }),
      ),
    ).toMatchObject({ ip: "203.0.113.7" });
  });

  it("ignores x-forwarded-for when no proxy is declared", () => {
    delete process.env.SPECBOARDS_TRUST_PROXY;
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }))).toEqual({
      known: false,
    });
  });

  it("uses x-forwarded-for when a proxy is declared to normalise it", () => {
    process.env.SPECBOARDS_TRUST_PROXY = "1";
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.1" }))).toEqual({
      known: true,
      ip: "198.51.100.1",
      source: "x-forwarded-for",
    });
  });

  it("takes the left-most entry from a trusted forwarded chain", () => {
    process.env.SPECBOARDS_TRUST_PROXY = "1";
    expect(
      clientIp(req({ "x-forwarded-for": "198.51.100.1, 10.0.0.1, 10.0.0.2" })),
    ).toMatchObject({ ip: "198.51.100.1" });
  });

  it("reports unknown when there is nothing to believe", () => {
    expect(clientIp(req({}))).toEqual({ known: false });
  });
});

describe("rateLimitKey", () => {
  afterEach(() => {
    delete process.env.SPECBOARDS_TRUST_PROXY;
    // Cleared here too: a case below sets it, and leaking it into the next
    // describe would make those cases pass for a reason they do not state.
    delete process.env.FLY_APP_NAME;
  });

  it("keys per client when the client is known", () => {
    // On Fly, where `fly-client-ip` is authoritative. Off Fly the same request
    // resolves to the shared bucket; see the clientIp cases above.
    process.env.FLY_APP_NAME = "specboard-test";
    expect(rateLimitKey(req({ "fly-client-ip": "203.0.113.7" }), "access-request")).toBe(
      "access-request:203.0.113.7",
    );
  });

  it("collapses unknown clients into one shared bucket", () => {
    // Blunt on purpose: a shared bucket throttles everyone during abuse, which
    // is worse for legitimate users than per-IP limiting and far better than an
    // unbounded endpoint. Crucially, it cannot be escaped by forging a header.
    const a = rateLimitKey(req({ "x-forwarded-for": "198.51.100.1" }), "access-request");
    const b = rateLimitKey(req({ "x-forwarded-for": "198.51.100.2" }), "access-request");
    expect(a).toBe(b);
    expect(a).toBe("access-request:unknown-client");
  });
});

describe("trustsForwardedFor", () => {
  afterEach(() => {
    delete process.env.SPECBOARDS_TRUST_PROXY;
  });

  it("defaults to not trusting", () => {
    expect(trustsForwardedFor()).toBe(false);
  });

  it("accepts the same truthy spellings as the other flags", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      process.env.SPECBOARDS_TRUST_PROXY = value;
      expect(trustsForwardedFor(), value).toBe(true);
    }
    for (const value of ["0", "false", "no", ""]) {
      process.env.SPECBOARDS_TRUST_PROXY = value;
      expect(trustsForwardedFor(), value).toBe(false);
    }
  });
});
