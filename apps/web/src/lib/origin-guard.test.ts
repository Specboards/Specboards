import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { assertCanonicalOrigin, canonicalOrigin } from "./origin-guard";

const ENV_KEYS = [
  "APP_URL",
  "BETTER_AUTH_URL",
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "SPECBOARDS_MULTI_TENANT",
] as const;
const saved: Record<string, string | undefined> = {};

describe("assertCanonicalOrigin boot guard", () => {
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

  it("skips local file mode with no GitHub App", () => {
    env({ SPECBOARDS_MULTI_TENANT: "true" });
    expect(() => assertCanonicalOrigin()).not.toThrow();
  });

  it("refuses multi-tenant boot without a configured origin", () => {
    env({ DATABASE_URL: "postgres://x", SPECBOARDS_MULTI_TENANT: "true" });
    expect(() => assertCanonicalOrigin()).toThrow(/APP_URL/);
  });

  it("only warns for single-tenant without a configured origin", () => {
    env({ DATABASE_URL: "postgres://x" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertCanonicalOrigin()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("refuses a malformed origin in any mode", () => {
    env({ DATABASE_URL: "postgres://x", APP_URL: "not a url" });
    expect(() => assertCanonicalOrigin()).toThrow(/not a valid URL/);
  });

  it("refuses a non-HTTPS public origin in multi-tenant mode", () => {
    env({
      DATABASE_URL: "postgres://x",
      APP_URL: "http://specboards.example.com",
      SPECBOARDS_MULTI_TENANT: "true",
    });
    expect(() => assertCanonicalOrigin()).toThrow(/not HTTPS/);
  });

  it("allows plain HTTP on localhost", () => {
    env({ DATABASE_URL: "postgres://x", APP_URL: "http://localhost:3000" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertCanonicalOrigin()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts an HTTPS origin in multi-tenant mode", () => {
    env({
      DATABASE_URL: "postgres://x",
      BETTER_AUTH_URL: "https://app.specboards.ai",
      SPECBOARDS_MULTI_TENANT: "true",
    });
    expect(() => assertCanonicalOrigin()).not.toThrow();
  });
});

describe("canonicalOrigin", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("strips trailing slashes and prefers APP_URL", () => {
    process.env.APP_URL = "https://a.example.com/";
    process.env.BETTER_AUTH_URL = "https://b.example.com";
    expect(canonicalOrigin()).toBe("https://a.example.com");
  });

  it("returns null when nothing is configured", () => {
    delete process.env.APP_URL;
    delete process.env.BETTER_AUTH_URL;
    expect(canonicalOrigin()).toBeNull();
  });
});
