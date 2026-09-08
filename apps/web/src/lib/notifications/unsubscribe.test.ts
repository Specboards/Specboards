import { afterEach, describe, expect, it } from "vitest";

import {
  unsubscribeToken,
  userIdFromUnsubscribeToken,
} from "@/lib/notifications/unsubscribe";

/**
 * The token that stands in for a session on the unsubscribe link.
 *
 * It is handed to every mail provider we send through and sits in inboxes
 * indefinitely, so the only thing keeping it from being a credential is that
 * it verifies for exactly one user and cannot be edited into another.
 */

const SECRET = "unsubscribe-unit-test-secret-of-sufficient-length";
const saved = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = saved;
});

describe("unsubscribe tokens", () => {
  function withSecret(secret = SECRET) {
    process.env.BETTER_AUTH_SECRET = secret;
  }

  it("verifies back to the user it was minted for", () => {
    withSecret();
    const token = unsubscribeToken("user-1")!;
    expect(userIdFromUnsubscribeToken(token)).toBe("user-1");
  });

  it("refuses a token whose user id has been swapped", () => {
    withSecret();
    const token = unsubscribeToken("user-1")!;
    const signature = token.slice(token.lastIndexOf(".") + 1);
    // The attack the signature exists for: keep a valid signature, point it at
    // somebody else, and unsubscribe them.
    expect(userIdFromUnsubscribeToken(`user-2.${signature}`)).toBeNull();
  });

  it("refuses a token whose signature has been edited", () => {
    withSecret();
    const token = unsubscribeToken("user-1")!;
    expect(userIdFromUnsubscribeToken(`${token}x`)).toBeNull();
    expect(userIdFromUnsubscribeToken(token.slice(0, -1))).toBeNull();
  });

  it("refuses a token minted under a different secret", () => {
    withSecret();
    const token = unsubscribeToken("user-1")!;
    withSecret("a-completely-different-secret-of-enough-length");
    expect(userIdFromUnsubscribeToken(token)).toBeNull();
  });

  it("refuses anything that is not a token at all", () => {
    withSecret();
    for (const junk of ["", ".", "nodot", ".sig", "user-1."]) {
      expect(userIdFromUnsubscribeToken(junk), junk).toBeNull();
    }
  });

  /**
   * Both halves fail closed rather than throwing. Minting runs inside the
   * relay, where an exception costs an event its notifications, and verifying
   * runs on a public page, where it would be a 500 in front of somebody trying
   * to unsubscribe.
   */
  it("mints and verifies nothing when there is no usable secret", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(unsubscribeToken("user-1")).toBeNull();
    expect(userIdFromUnsubscribeToken("user-1.whatever")).toBeNull();

    withSecret("too-short");
    expect(unsubscribeToken("user-1")).toBeNull();
  });
});
