import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { assertLocalMode, isLocalFileMode, localModeRefusal } from "./local-mode";

/**
 * The local-mode guard. Absence of `DATABASE_URL` used to select an
 * unauthenticated file-backed store all by itself, so a deployment that lost
 * its connection string came up as an open, spec-deleting server rather than a
 * broken one. These pin both halves of the fix: the boot guard that refuses,
 * and `isLocalFileMode()`, which the authorize helpers consult per request so a
 * misconfigured process denies instead of authorizing.
 */

const ENV_KEYS = [
  "DATABASE_URL",
  "SPECBOARDS_LOCAL_MODE",
  "SPECBOARDS_MULTI_TENANT",
  "APP_URL",
  "BETTER_AUTH_URL",
  "HOSTNAME",
] as const;
const saved: Record<string, string | undefined> = {};

/** NODE_ENV is read-only in the type system; vitest's stub is the way in. */
type EnvOverrides = Partial<Record<(typeof ENV_KEYS)[number], string>> & {
  NODE_ENV?: string;
};

describe("local file mode guard", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function env({ NODE_ENV, ...overrides }: EnvOverrides): void {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    // Always stubbed, so a case that says nothing about NODE_ENV is not at the
    // mercy of how the test runner happens to set it.
    vi.stubEnv("NODE_ENV", NODE_ENV ?? "test");
  }

  describe("with a database", () => {
    it("has nothing to say", () => {
      env({ DATABASE_URL: "postgres://x" });
      expect(localModeRefusal()).toBeNull();
      expect(isLocalFileMode()).toBe(false);
      expect(() => assertLocalMode()).not.toThrow();
    });

    it("ignores a stray local-mode flag when a database is configured", () => {
      env({ DATABASE_URL: "postgres://x", SPECBOARDS_LOCAL_MODE: "1" });
      expect(isLocalFileMode()).toBe(false);
      expect(() => assertLocalMode()).not.toThrow();
    });
  });

  describe("without a database", () => {
    it("refuses to start when local mode was not asked for", () => {
      // The finding: this used to be the silent fallback.
      env({});
      expect(() => assertLocalMode()).toThrow(/DATABASE_URL is not set/);
      expect(localModeRefusal()).toMatch(/SPECBOARDS_LOCAL_MODE/);
    });

    it("reports NOT local mode when the flag is missing, so callers fail closed", () => {
      // The second layer: even if the boot guard were skipped, the authorize
      // helpers must not read "no database" as "no authorization needed".
      env({});
      expect(isLocalFileMode()).toBe(false);
    });

    it("refuses multi-tenant outright, flag or no flag", () => {
      env({ SPECBOARDS_MULTI_TENANT: "true", SPECBOARDS_LOCAL_MODE: "1" });
      expect(() => assertLocalMode()).toThrow(/multi-tenant/i);
    });

    it("allows an explicit, loopback-only local run", () => {
      env({ SPECBOARDS_LOCAL_MODE: "1", APP_URL: "http://localhost:3000" });
      expect(localModeRefusal()).toBeNull();
      expect(isLocalFileMode()).toBe(true);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => assertLocalMode()).not.toThrow();
      // Nobody should be able to say they were not told.
      expect(warn.mock.calls[0]?.[0]).toMatch(/NO AUTHENTICATION/);
    });

    it("accepts the same truthy spellings as the other flags", () => {
      for (const value of ["1", "true", "TRUE", "yes"]) {
        env({ SPECBOARDS_LOCAL_MODE: value });
        expect(isLocalFileMode(), value).toBe(true);
      }
      for (const value of ["0", "false", "no", ""]) {
        env({ SPECBOARDS_LOCAL_MODE: value });
        expect(isLocalFileMode(), value).toBe(false);
      }
    });

    it("refuses a non-loopback bind address", () => {
      // What the production container sets (web.Dockerfile: HOSTNAME=0.0.0.0).
      env({ SPECBOARDS_LOCAL_MODE: "1", HOSTNAME: "0.0.0.0" });
      expect(() => assertLocalMode()).toThrow(/binds 0\.0\.0\.0/);
    });

    it("allows explicit loopback binds", () => {
      for (const bind of ["127.0.0.1", "localhost", "::1"]) {
        env({ SPECBOARDS_LOCAL_MODE: "1", HOSTNAME: bind });
        expect(localModeRefusal(), bind).toBeNull();
      }
    });

    it("refuses a public origin", () => {
      env({ SPECBOARDS_LOCAL_MODE: "1", APP_URL: "https://app.specboards.ai" });
      expect(() => assertLocalMode()).toThrow(/public origin/);
    });

    it("checks BETTER_AUTH_URL too when APP_URL is unset", () => {
      env({ SPECBOARDS_LOCAL_MODE: "1", BETTER_AUTH_URL: "https://test.specboards.ai" });
      expect(() => assertLocalMode()).toThrow(/public origin/);
    });

    it("refuses an unparseable origin rather than guessing", () => {
      env({ SPECBOARDS_LOCAL_MODE: "1", APP_URL: "not a url" });
      expect(() => assertLocalMode()).toThrow(/not a valid URL/);
    });
  });

  describe("the dev server", () => {
    it("does not need the flag: `pnpm dev` with no database still works", () => {
      env({ NODE_ENV: "development" });
      expect(localModeRefusal()).toBeNull();
      expect(isLocalFileMode()).toBe(true);
    });

    it("is still refused when exposed off this machine", () => {
      // A dev server bound to 0.0.0.0 on a shared network is the same open,
      // unauthenticated server as a misconfigured deployment.
      env({ NODE_ENV: "development", HOSTNAME: "0.0.0.0" });
      expect(() => assertLocalMode()).toThrow(/binds 0\.0\.0\.0/);
    });

    it("does not excuse a multi-tenant configuration", () => {
      env({ NODE_ENV: "development", SPECBOARDS_MULTI_TENANT: "true" });
      expect(() => assertLocalMode()).toThrow(/multi-tenant/i);
    });

    it("is not implied by a production build, which is what deploys", () => {
      // `next start` reports NODE_ENV=production for a local build too, so this
      // is the case that must never be waved through.
      env({ NODE_ENV: "production" });
      expect(isLocalFileMode()).toBe(false);
      expect(() => assertLocalMode()).toThrow(/DATABASE_URL is not set/);
    });
  });
});
