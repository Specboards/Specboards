import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertSignUpCodeConfigured,
  expectedSignUpCode,
  signUpCodeMatches,
  signUpCodeRequired,
} from "./access-gate";

const ENV_KEYS = ["SPECBOARDS_SIGNUP_CODE", "SPECBOARDS_SIGNUP_CODE_REQUIRED"] as const;
const saved: Record<string, string | undefined> = {};

describe("sign-up code gate", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  function env(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  }

  describe("expectedSignUpCode", () => {
    it("has no default, so an unset variable means no code", () => {
      env({});
      expect(expectedSignUpCode()).toBeNull();
    });

    it("treats a whitespace-only value as unset", () => {
      env({ SPECBOARDS_SIGNUP_CODE: "   " });
      expect(expectedSignUpCode()).toBeNull();
    });

    it("trims the configured value", () => {
      env({ SPECBOARDS_SIGNUP_CODE: "  LET-ME-IN  " });
      expect(expectedSignUpCode()).toBe("LET-ME-IN");
    });
  });

  describe("signUpCodeMatches", () => {
    it("matches case-insensitively and ignores surrounding whitespace", () => {
      env({ SPECBOARDS_SIGNUP_CODE: "LET-ME-IN" });
      expect(signUpCodeMatches("let-me-in")).toBe(true);
      expect(signUpCodeMatches("  LET-ME-IN\n")).toBe(true);
      expect(signUpCodeMatches("let me in")).toBe(false);
    });

    // The boot guard should make this unreachable. It is the layer under it:
    // with no code configured there is nothing to match, so nothing passes.
    it("refuses every submission when no code is configured", () => {
      env({});
      expect(signUpCodeMatches("")).toBe(false);
      expect(signUpCodeMatches("SPECBUILDER2026")).toBe(false);
      expect(signUpCodeMatches("anything at all")).toBe(false);
    });
  });

  describe("assertSignUpCodeConfigured", () => {
    it("refuses to boot with the gate on and no code set", () => {
      env({ SPECBOARDS_SIGNUP_CODE_REQUIRED: "true" });
      expect(() => assertSignUpCodeConfigured()).toThrow(/SPECBOARDS_SIGNUP_CODE/);
    });

    it("refuses to boot with the gate on and a blank code", () => {
      env({ SPECBOARDS_SIGNUP_CODE_REQUIRED: "1", SPECBOARDS_SIGNUP_CODE: "  " });
      expect(() => assertSignUpCodeConfigured()).toThrow(/Refusing to start/);
    });

    it("boots with the gate on and a code set", () => {
      env({ SPECBOARDS_SIGNUP_CODE_REQUIRED: "yes", SPECBOARDS_SIGNUP_CODE: "LET-ME-IN" });
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(() => assertSignUpCodeConfigured()).not.toThrow();
    });

    // Fails closed in every tenancy mode, unlike the origin and RLS guards:
    // there is no legitimate deployment running the gate without a code.
    it("refuses regardless of tenancy mode", () => {
      env({ SPECBOARDS_SIGNUP_CODE_REQUIRED: "true" });
      process.env.SPECBOARDS_MULTI_TENANT = "false";
      try {
        expect(() => assertSignUpCodeConfigured()).toThrow(/Refusing to start/);
      } finally {
        delete process.env.SPECBOARDS_MULTI_TENANT;
      }
    });

    it("is a no-op when the gate is off", () => {
      env({});
      expect(signUpCodeRequired()).toBe(false);
      expect(() => assertSignUpCodeConfigured()).not.toThrow();
    });

    it("is a no-op when the gate is off even with a stale code lying around", () => {
      env({ SPECBOARDS_SIGNUP_CODE: "LET-ME-IN" });
      expect(() => assertSignUpCodeConfigured()).not.toThrow();
    });
  });
});
