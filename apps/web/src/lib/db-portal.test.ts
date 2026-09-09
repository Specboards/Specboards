import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getPortalDb()` returns a client only when a portal connection is configured,
 * and never falls back to the owner connection.
 *
 * The portal is the one surface served to somebody with no account. Reading it
 * on `DATABASE_URL` means reading on the owner connection, which bypasses row
 * level security and every publication policy, so it would serve unpublished
 * ideas and unannounced product names to anonymous visitors.
 *
 * ── This used to throw, and that was worse than the problem ────────────────
 * The first version threw in multi-tenant mode rather than returning null,
 * copying `getWorkerDb()`. Paired with a boot guard that threw for the same
 * reason, it took the test deployment down: the guard shipped in the same change
 * as the feature, so the app refused to start before anybody could provision the
 * role it was demanding.
 *
 * Null gets the same protection with no outage. The portal is optional; a
 * deployment without one is not degraded, and `resolvePortal` turns null into a
 * 404 on every portal URL. Nothing is served, so there is nothing to protect.
 *
 * Each case re-imports the module. `getPortalDb()` memoises its client in a
 * module-level variable, so a second call in the same module instance returns
 * the first answer whatever the environment now says, and the cases would test
 * each other's leftovers rather than the code.
 */

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_PORTAL",
  "SPECBOARDS_MULTI_TENANT",
] as const;
const saved: Record<string, string | undefined> = {};

/** A fresh module instance, so the memoised client cannot leak between cases. */
async function freshGetPortalDb() {
  vi.resetModules();
  const mod = await import("./db");
  return mod.getPortalDb;
}

describe("getPortalDb", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
  });

  it("is null in local file mode, where there is no Postgres at all", async () => {
    const getPortalDb = await freshGetPortalDb();
    expect(getPortalDb()).toBeNull();
  });

  it("is null on a hosted deployment with no portal role, rather than throwing", async () => {
    // The regression. Throwing here, with a boot guard throwing for the same
    // reason, is what took test down: the guard demanded a role that could not
    // exist yet, so the app would not start to be provisioned.
    process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";
    process.env.SPECBOARDS_MULTI_TENANT = "true";

    const getPortalDb = await freshGetPortalDb();
    expect(() => getPortalDb()).not.toThrow();
    expect(getPortalDb()).toBeNull();
  });

  it("never falls back to the owner connection, in either mode", async () => {
    // The protection the throw was for, kept. A single-tenant self-host loses
    // the fallback that `getAppDb()` and `getWorkerDb()` keep, deliberately:
    // the app and the workers must function on one connection string, and a
    // portal need not, because it is opt-in and nobody is broken without one.
    for (const multiTenant of ["true", undefined]) {
      process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";
      if (multiTenant) process.env.SPECBOARDS_MULTI_TENANT = multiTenant;
      else delete process.env.SPECBOARDS_MULTI_TENANT;

      const getPortalDb = await freshGetPortalDb();
      expect(getPortalDb(), `multiTenant=${multiTenant}`).toBeNull();
    }
  });

  it("returns a client once the portal connection is configured", async () => {
    process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";
    process.env.DATABASE_URL_PORTAL = "postgres://portal@localhost:5432/db";
    process.env.SPECBOARDS_MULTI_TENANT = "true";

    const getPortalDb = await freshGetPortalDb();
    expect(getPortalDb()).not.toBeNull();
  });
});
