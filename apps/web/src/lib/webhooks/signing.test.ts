import { describe, expect, it } from "vitest";

import { signatureHeader, verifySignature } from "@/lib/webhooks/signing";

/**
 * The signing scheme is a promise we make to consumers: the webhooks settings
 * card tells them each delivery is an HMAC-SHA256 over `{timestamp}.{body}` in
 * an `X-Specboards-Signature` header, and they write code against that.
 *
 * `verifySignature` is our executable statement of that promise, and until now
 * nothing ran it. Its own comment said it existed "so our own send-test-event
 * round-trips and the scheme stays honest", which was aspirational: knip found
 * it exported and called by nobody. These tests make the claim true, and are
 * the reason it survived the dead-code pass rather than being deleted.
 *
 * What is being pinned is the *contract*, not the implementation. Each case is
 * something a consumer's verifier would also have to get right, so a change
 * here that breaks one of them is a breaking change for everyone integrating.
 */
const SECRET = "whsec_test_1234567890";
const BODY = JSON.stringify({ id: "evt_1", type: "item.created" });
const NOW = 1_767_225_600; // fixed: signatures must not depend on wall clock

describe("webhook signatures", () => {
  it("round-trips a header it just produced", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, NOW)).toBe(true);
  });

  it("emits the documented t=,v1= shape with a hex digest", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${NOW},`)).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, `${BODY} `, header, NOW)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature("whsec_other", BODY, header, NOW)).toBe(false);
  });

  it("signs the raw body, not a re-serialization", () => {
    // Same object, different key order: a consumer verifying against bytes it
    // re-serialized itself would fail, which is why we sign what we send.
    const reordered = JSON.stringify({ type: "item.created", id: "evt_1" });
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(reordered).not.toBe(BODY);
    expect(verifySignature(SECRET, reordered, header, NOW)).toBe(false);
  });

  describe("replay window", () => {
    it("accepts a delivery inside the default tolerance", () => {
      const header = signatureHeader(SECRET, BODY, NOW);
      expect(verifySignature(SECRET, BODY, header, NOW + 299)).toBe(true);
    });

    it("rejects one outside it, in either direction", () => {
      const header = signatureHeader(SECRET, BODY, NOW);
      expect(verifySignature(SECRET, BODY, header, NOW + 301)).toBe(false);
      // A future timestamp is as suspect as a stale one: clock skew is
      // symmetric, and a signer whose clock runs ahead is not a replay.
      expect(verifySignature(SECRET, BODY, header, NOW - 301)).toBe(false);
    });

    it("honours an explicit tolerance", () => {
      const header = signatureHeader(SECRET, BODY, NOW);
      expect(verifySignature(SECRET, BODY, header, NOW + 400, 600)).toBe(true);
      expect(verifySignature(SECRET, BODY, header, NOW + 400, 60)).toBe(false);
    });

    it("rejects a header whose timestamp was edited to stay in window", () => {
      // Moving `t` forward to dodge the window check has to invalidate the
      // digest, because the timestamp is inside the signed string.
      const header = signatureHeader(SECRET, BODY, NOW);
      const moved = header.replace(`t=${NOW}`, `t=${NOW + 400}`);
      expect(verifySignature(SECRET, BODY, moved, NOW + 400)).toBe(false);
    });
  });

  describe("malformed headers", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    const cases: [string, string][] = [
      ["empty", ""],
      ["no v1", `t=${NOW}`],
      ["no t", header.slice(header.indexOf("v1="))],
      ["non-numeric t", `t=later,v1=${"a".repeat(64)}`],
      ["digest too short", `t=${NOW},v1=abcd`],
      ["digest too long", `t=${NOW},v1=${"a".repeat(65)}`],
      ["not a signature at all", "Bearer token"],
    ];
    // A malformed header must return false rather than throw: this runs on
    // input an attacker controls, and an exception is a different response
    // from a rejection.
    for (const [name, value] of cases) {
      it(`returns false for ${name}`, () => {
        expect(() => verifySignature(SECRET, BODY, value, NOW)).not.toThrow();
        expect(verifySignature(SECRET, BODY, value, NOW)).toBe(false);
      });
    }
  });
});
