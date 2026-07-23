import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { assertTenantIsolation, assertWorkerIsolation } from "./rls-guard";

/**
 * Boot-guard behavior against a real database: a hosted (multi-tenant)
 * deployment must refuse to start when its tenant-data connection would
 * bypass RLS, and accept a properly constrained one. Uses the same
 * `rls_int_app` role the isolation suite provisions, so this file must run
 * after it (vitest runs files in order under fileParallelism: false; the
 * beforeAll below provisions the role itself to stay order-independent).
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrl(): string {
  const url = new URL(OWNER_URL!);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_APP",
  "DATABASE_URL_WORKER",
  "SPECBOARDS_MULTI_TENANT",
] as const;
const saved: Record<string, string | undefined> = {};

describe.skipIf(!OWNER_URL)("assertTenantIsolation boot guard", () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const { default: postgres } = await import("postgres");
    const owner = postgres(OWNER_URL!, { prepare: false, max: 1 });
    try {
      await owner.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
            create role ${APP_ROLE} login password '${APP_PASSWORD}';
          end if;
        end $$;
        grant usage on schema public to ${APP_ROLE};
        grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
        grant usage, select on all sequences in schema public to ${APP_ROLE};
        grant execute on all functions in schema public to ${APP_ROLE};
      `);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("refuses multi-tenant boot without DATABASE_URL_APP", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    delete process.env.DATABASE_URL_APP;
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertTenantIsolation()).rejects.toThrow(/DATABASE_URL_APP is required|Refusing to start/);
  });

  it("refuses multi-tenant boot when DATABASE_URL_APP points at the owner", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    process.env.DATABASE_URL_APP = OWNER_URL;
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertTenantIsolation()).rejects.toThrow(/bypasses row-level security/);
  });

  it("accepts multi-tenant boot with the non-owner role", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    process.env.DATABASE_URL_APP = appUrl();
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertTenantIsolation()).resolves.toBeUndefined();
  });

  it("only warns for single-tenant self-host on one owner connection", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    delete process.env.DATABASE_URL_APP;
    delete process.env.SPECBOARDS_MULTI_TENANT;
    await expect(assertTenantIsolation()).resolves.toBeUndefined();
  });

  // Worker guard: same fail-closed contract for the background-worker
  // connection. The probe checks role properties, not worker-specific grants,
  // so the non-owner app role stands in for a provisioned worker role.
  it("refuses multi-tenant boot without DATABASE_URL_WORKER", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    delete process.env.DATABASE_URL_WORKER;
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertWorkerIsolation()).rejects.toThrow(/DATABASE_URL_WORKER/);
  });

  it("refuses multi-tenant boot when DATABASE_URL_WORKER points at the owner", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    process.env.DATABASE_URL_WORKER = OWNER_URL;
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertWorkerIsolation()).rejects.toThrow(/bypasses row-level security/);
  });

  it("accepts multi-tenant boot with a non-owner worker role", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    process.env.DATABASE_URL_WORKER = appUrl();
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    await expect(assertWorkerIsolation()).resolves.toBeUndefined();
  });

  it("only warns for single-tenant self-host workers on the owner connection", async () => {
    process.env.DATABASE_URL = OWNER_URL;
    delete process.env.DATABASE_URL_WORKER;
    delete process.env.SPECBOARDS_MULTI_TENANT;
    await expect(assertWorkerIsolation()).resolves.toBeUndefined();
  });
});
