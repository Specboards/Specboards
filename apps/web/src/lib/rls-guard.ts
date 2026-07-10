import { probeTenantConnection, tenantIsolationViolations } from "@specboard/db";

import { isMultiTenant } from "@/lib/tenancy";

/**
 * Boot-time enforcement that hosted tenant isolation fails closed. Called
 * from instrumentation.ts when the server starts.
 *
 * Multi-tenant deployments MUST serve tenant data through a connection RLS
 * actually applies to. `getStore()` already refuses the owner fallback per
 * request; this guard moves the same failure to deploy time (a thrown error
 * here crashes startup, so the platform's health checks stop the rollout) and
 * additionally catches the subtler misconfigurations where DATABASE_URL_APP
 * is set but points at a role RLS does not constrain (owner, superuser,
 * BYPASSRLS, RLS disabled, no policies).
 *
 * Single-tenant self-host keeps working with one owner connection: there is
 * no co-tenant to leak into, so we only warn. If a self-host sets
 * DATABASE_URL_APP, the probe still runs and reports problems loudly, but
 * does not refuse to boot.
 */
export async function assertTenantIsolation(): Promise<void> {
  // Local file mode: no Postgres at all.
  if (!process.env.DATABASE_URL) return;

  const appUrl = process.env.DATABASE_URL_APP;
  if (!appUrl) {
    if (isMultiTenant()) {
      throw new Error(
        "[security] Refusing to start: SPECBOARD_MULTI_TENANT is set but DATABASE_URL_APP " +
          "is not. Tenant data would be served over the owner connection, which bypasses " +
          "row-level security. Provision the non-owner role (infra/rls-role.sql) and set " +
          "DATABASE_URL_APP.",
      );
    }
    console.warn(
      "[security] DATABASE_URL_APP is not set: tenant data uses the owner connection and " +
        "RLS is not enforced by the database. This is acceptable only for single-tenant " +
        "self-host; see docs/PLAN-rls-role-cutover.md.",
    );
    return;
  }

  let violations: string[];
  try {
    violations = tenantIsolationViolations(await probeTenantConnection(appUrl));
  } catch (err) {
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: could not verify the tenant-data connection is RLS-safe: ${String(err)}`,
      );
    }
    console.warn("[security] RLS probe failed (continuing, single-tenant):", err);
    return;
  }

  if (violations.length > 0) {
    const detail = violations.join("; ");
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: the DATABASE_URL_APP connection bypasses row-level security: ${detail}.`,
      );
    }
    console.warn(`[security] DATABASE_URL_APP connection is not RLS-safe: ${detail}.`);
    return;
  }

  console.log("[security] tenant-data connection verified RLS-safe.");
}
