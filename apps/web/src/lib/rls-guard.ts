import {
  probePortalCannotReadUnpublished,
  probeTenantConnection,
  tenantIsolationViolations,
} from "@specboards/db";

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
        "[security] Refusing to start: SPECBOARDS_MULTI_TENANT is set but DATABASE_URL_APP " +
          "is not. Tenant data would be served over the owner connection, which bypasses " +
          "row-level security. Provision the non-owner role (infra/rls-role.sql) and set " +
          "DATABASE_URL_APP.",
      );
    }
    console.warn(
      "[security] DATABASE_URL_APP is not set: tenant data uses the owner connection and " +
        "RLS is not enforced by the database. This is acceptable only for single-tenant " +
        "self-host; see docs/RUNBOOK-db-role-cutover.md.",
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

/**
 * Same fail-closed contract for the background-worker connection. The worker
 * paths (outbox drainer/relay, incoming GitHub webhook sink) span every
 * workspace, so they run as the dedicated `specboards_worker` role whose
 * cross-workspace reach is still bounded by grants and role-targeted policies
 * (see infra/worker-role.sql). Without this guard a multi-tenant deployment
 * that forgot to provision DATABASE_URL_WORKER would silently run those paths
 * on the owner connection, which has no such bounds.
 */
export async function assertWorkerIsolation(): Promise<void> {
  // Local file mode: no Postgres at all.
  if (!process.env.DATABASE_URL) return;

  const workerUrl = process.env.DATABASE_URL_WORKER;
  if (!workerUrl) {
    if (isMultiTenant()) {
      throw new Error(
        "[security] Refusing to start: SPECBOARDS_MULTI_TENANT is set but DATABASE_URL_WORKER " +
          "is not. Background workers would fall back to the owner connection, which bypasses " +
          "row-level security and every worker grant boundary. Provision the worker role " +
          "(infra/worker-role.sql) and set DATABASE_URL_WORKER.",
      );
    }
    console.warn(
      "[security] DATABASE_URL_WORKER is not set: background workers use the owner connection. " +
        "This is acceptable only for single-tenant self-host; see infra/worker-role.sql.",
    );
    return;
  }

  let violations: string[];
  try {
    violations = tenantIsolationViolations(await probeTenantConnection(workerUrl));
  } catch (err) {
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: could not verify the worker connection is RLS-safe: ${String(err)}`,
      );
    }
    console.warn("[security] worker RLS probe failed (continuing, single-tenant):", err);
    return;
  }

  if (violations.length > 0) {
    const detail = violations.join("; ");
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: the DATABASE_URL_WORKER connection bypasses row-level security: ${detail}.`,
      );
    }
    console.warn(`[security] DATABASE_URL_WORKER connection is not RLS-safe: ${detail}.`);
    return;
  }

  console.log("[security] worker connection verified RLS-safe.");
}

/**
 * Same fail-closed contract for the public portal connection, plus one check
 * the generic probe cannot make.
 *
 * The portal is the only surface served to somebody with no account, so it runs
 * as the read-only `specboards_portal` role whose policies encode publication
 * itself (see infra/portal-role.sql and migration 0009). Without this guard a
 * multi-tenant deployment that forgot to provision DATABASE_URL_PORTAL would
 * fall back to the owner connection and serve unpublished rows to anonymous
 * visitors, which is the single worst failure this codebase can have.
 *
 * ── Why the shared probe is not enough here ────────────────────────────────
 * `tenantIsolationViolations` answers "could RLS apply to this connection":
 * not a superuser, no BYPASSRLS, does not own the tables, RLS enabled,
 * policies present. All five can be true of a connection whose policies say
 * `USING (true)`. For the app role that gap is tolerable, because a policy
 * that matches everything still only matches what `app.user_id` scopes it to.
 * For this role there is no session scope at all: a permissive policy IS the
 * leak, and it would satisfy every check above.
 *
 * So we ask the database the actual question instead of inferring it, and the
 * question is asked in the direction that fails safe. A row that exists and
 * must not be visible is the whole risk; a row that is visible and should be is
 * merely a bug. `probePortalCannotReadUnpublished` reads an unpublished
 * `idea_settings` row through the portal role and expects nothing back.
 */
export async function assertPortalIsolation(): Promise<void> {
  // Local file mode: no Postgres at all.
  if (!process.env.DATABASE_URL) return;

  const portalUrl = process.env.DATABASE_URL_PORTAL;
  if (!portalUrl) {
    // An unconfigured portal is a feature that is off, not a misconfiguration.
    //
    // This used to throw in multi-tenant mode, copying `assertWorkerIsolation`
    // above, and that was wrong in a way that took the test deployment down for
    // hours: the guard shipped in the same change as the code it guards, so the
    // moment it deployed the app refused to boot, before anybody could
    // provision the role it was asking for. The runbook it points at even says
    // deploying ahead of provisioning is safe. It was not.
    //
    // The difference from the worker is the whole point and it is not subtle.
    // Background workers are mandatory: a deployment without them silently
    // stops delivering webhooks and notifications, so failing to start is
    // better than running half-dead. A portal is optional, and a deployment
    // without one is not degraded, it simply has no portal. `getPortalDb()`
    // returns null, `resolvePortal` returns null, every portal URL 404s. There
    // is nothing to protect against because there is nothing being served.
    //
    // Silent, deliberately. A self-host that will never publish a portal should
    // not be told at every boot about a role it does not need.
    return;
  }

  let violations: string[];
  try {
    violations = tenantIsolationViolations(await probeTenantConnection(portalUrl));
  } catch (err) {
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: could not verify the portal connection is RLS-safe: ${String(err)}`,
      );
    }
    console.warn("[security] portal RLS probe failed (continuing, single-tenant):", err);
    return;
  }

  if (violations.length > 0) {
    const detail = violations.join("; ");
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: the DATABASE_URL_PORTAL connection bypasses row-level security: ${detail}.`,
      );
    }
    console.warn(`[security] DATABASE_URL_PORTAL connection is not RLS-safe: ${detail}.`);
    return;
  }

  // The check the generic probe cannot make. Asked in the direction that fails
  // safe: a row that exists and must not be readable is the entire risk.
  try {
    const leaked = await probePortalCannotReadUnpublished(portalUrl);
    if (leaked > 0) {
      const detail =
        `the portal connection can read ${leaked} idea_settings row(s) whose portal is ` +
        "switched off, so its policies are not enforcing publication";
      if (isMultiTenant()) {
        throw new Error(`[security] Refusing to start: ${detail}.`);
      }
      console.warn(`[security] ${detail}.`);
      return;
    }
  } catch (err) {
    // A thrown refusal above must not be swallowed by this catch.
    if (err instanceof Error && err.message.startsWith("[security] Refusing")) {
      throw err;
    }
    if (isMultiTenant()) {
      throw new Error(
        `[security] Refusing to start: could not verify the portal connection refuses ` +
          `unpublished rows: ${String(err)}`,
      );
    }
    console.warn("[security] portal publication probe failed (continuing, single-tenant):", err);
    return;
  }

  console.log("[security] portal connection verified RLS-safe and publication-scoped.");
}
