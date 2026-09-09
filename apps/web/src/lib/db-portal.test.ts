import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getPortalDb()`'s refusal, which is the only part of it worth testing and the
 * part that matters most.
 *
 * The portal is the one surface served to somebody with no account. If it ever
 * falls back to `DATABASE_URL` it is reading on the owner connection, which
 * bypasses row-level security, and it will serve unpublished ideas,
 * unannounced product names and other tenants' rows to anonymous visitors. So
 * on a hosted deployment the fallback has to be a refusal, not a warning.
 *
 * `assertPortalIsolation()` covers the same ground at boot, and this is the
 * per-call backstop for a portal path that outlives the guard. `getWorkerDb()`
 * carries the identical pair, and its own comment explains why both exist.
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

  it("refuses the owner-connection fallback on a hosted deployment", async () => {
    // The case this function exists for. A multi-tenant deployment that has not
    // provisioned the portal role must fail loudly rather than quietly serve
    // every tenant's unpublished rows to the internet.
    process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";
    process.env.SPECBOARDS_MULTI_TENANT = "true";

    const getPortalDb = await freshGetPortalDb();
    expect(() => getPortalDb()).toThrow(/DATABASE_URL_PORTAL is required/);
    // The message has to name the consequence, not just the variable: whoever
    // hits this is mid-deploy and needs to know it is not a formality.
    expect(() => getPortalDb()).toThrow(/anonymous visitors/);
  });

  it("does not cache the refusal, so fixing the env fixes the process", async () => {
    // Same reasoning as `getAppDb()`: caching a throw would mean one unlucky
    // boot poisons the process until it is restarted, and the operator who has
    // just set the secret would still see failures.
    process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";
    process.env.SPECBOARDS_MULTI_TENANT = "true";

    const getPortalDb = await freshGetPortalDb();
    expect(() => getPortalDb()).toThrow();

    process.env.DATABASE_URL_PORTAL = "postgres://portal@localhost:5432/db";
    expect(getPortalDb()).not.toBeNull();
  });

  it("keeps the fallback for single-tenant self-host", async () => {
    // No co-tenant to leak into, and demanding a second connection string
    // would be setup friction for somebody who may never enable a portal. The
    // same bargain `getWorkerDb()` and `getAppDb()` already make.
    process.env.DATABASE_URL = "postgres://owner@localhost:5432/db";

    const getPortalDb = await freshGetPortalDb();
    expect(getPortalDb()).not.toBeNull();
  });
});
