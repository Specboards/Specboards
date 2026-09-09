import { createDb, type Database } from "@specboards/db";

import { isMultiTenant } from "@/lib/tenancy";

let db: Database | null | undefined;

/**
 * Drizzle client for the web app, resolved once per process. Gated on
 * `DATABASE_URL` (mirrors `getStore()` / `getAuth()`): `null` in local file
 * mode, where there is no Postgres and auth/workspaces are disabled.
 *
 * ── Row-level security does not apply to this connection ────────────────────
 * `DATABASE_URL` is the owner and DDL connection, and Postgres exempts a
 * table's owner from row-level security unless that table also carries `FORCE
 * ROW LEVEL SECURITY`. Nothing in `infra/` sets it, on any table. The
 * RLS-enforced role is `specboards_app` on `DATABASE_URL_APP`, and the only
 * thing that connects as it is `getStore()`.
 *
 * So on every path that resolves `getDb()`, tenant isolation is whatever the
 * query says it is. The `workspaceId` predicate in the service layer is not a
 * belt beside the braces of a policy; it IS the enforcement, and a query that
 * omits it reads every tenant's rows.
 *
 * That is why onboarding, auth, GitHub setup and the rest still live here: they
 * act before a workspace membership exists, or across one, and have no acting
 * member for a policy to key on. Use this connection when that is genuinely
 * true, and `getAppDb()` when it is not.
 *
 * The model-provider, usage, assistant and skills paths USED to be here, which
 * made the policies in 0067, 0068, 0070 and 0074 inert. They now run on
 * `getAppDb()`. `owner-connection-rls.int.test.ts` pins the facts that made the
 * move delicate.
 */
export function getDb(): Database | null {
  if (db === undefined) {
    const url = process.env.DATABASE_URL;
    db = url ? createDb(url) : null;
  }
  return db;
}

let appDb: Database | null | undefined;

/**
 * Drizzle client for tenant data on the RLS-enforced connection.
 *
 * `DATABASE_URL_APP` is the non-owner `specboards_app` role, the one every
 * policy in `infra/migrations` is written against. Queries made through it are
 * filtered by those policies, so a `workspaceId` predicate that is forgotten or
 * wrong is caught by the database rather than shipped.
 *
 * The same connection `getStore()` uses, and gated the same way, deliberately:
 * in multi-tenant mode falling back to `DATABASE_URL` would silently reinstate
 * the owner connection and the bypass with it, so it refuses. Single-tenant
 * self-host keeps the fallback, because there is no co-tenant to leak into and
 * requiring a second connection string would be setup friction for no gain. On
 * that fallback the policies genuinely do not apply, which is the same bargain
 * `getStore()` and `getWorkerDb()` already make.
 *
 * Reads and writes through this MUST go through `asUser()` in `db-scope.ts`, or
 * the policies evaluate with no `app.user_id` and match nothing. That is a safe
 * failure (empty results, refused writes) rather than a leak, but it is a
 * confusing one, so reach for the helper rather than this handle directly.
 */
export function getAppDb(): Database | null {
  if (appDb === undefined) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      appDb = null;
      return appDb;
    }
    const scopedUrl = process.env.DATABASE_URL_APP;
    if (!scopedUrl && isMultiTenant()) {
      // Not cached: every tenant-data request fails until the env is fixed,
      // rather than one unlucky boot poisoning the process. Same shape as
      // getStore().
      throw new Error(
        "[security] getAppDb: DATABASE_URL_APP is required in multi-tenant mode; " +
          "refusing the owner-connection fallback, which bypasses row-level security.",
      );
    }
    appDb = createDb(scopedUrl ?? url);
  }
  return appDb;
}

let workerDb: Database | null | undefined;

/**
 * Drizzle client for background / ingestion workers: the outbox delivery
 * drainer + relay and the incoming GitHub webhook sink. Those paths span every
 * workspace with no per-user scope, so they can't use the RLS-scoped app
 * connection (`getStore()`); historically they ran on the owner connection,
 * which bypasses RLS. They now connect as the dedicated non-owner
 * `specboards_worker` role via `DATABASE_URL_WORKER`, which is granted only the
 * handful of tables those paths touch and carries role-targeted RLS policies
 * for the cross-workspace access they need (see `infra/worker-role.sql`).
 *
 * When `DATABASE_URL_WORKER` is unset, single-tenant self-host falls back to
 * the owner connection (there is no co-tenant to leak into). Multi-tenant
 * deployments refuse the fallback: the boot guard (`assertWorkerIsolation`)
 * already fails startup in that case, and this throw is the defense-in-depth
 * backstop should a worker path outlive the guard. Like `getDb()`, this is
 * `null` in local file mode where there is no Postgres.
 */
export function getWorkerDb(): Database | null {
  if (workerDb === undefined) {
    let url = process.env.DATABASE_URL_WORKER;
    if (!url) {
      if (isMultiTenant() && process.env.DATABASE_URL) {
        throw new Error(
          "[security] getWorkerDb: DATABASE_URL_WORKER is required in multi-tenant mode; " +
            "refusing the owner-connection fallback (see infra/worker-role.sql).",
        );
      }
      url = process.env.DATABASE_URL;
    }
    workerDb = url ? createDb(url) : null;
  }
  return workerDb;
}

let portalDb: Database | null | undefined;

/**
 * Drizzle client for the public Ideas portal and public roadmap: the only
 * surface served to somebody with no account.
 *
 * Neither of the other two connections can do this job. `getAppDb()` policies
 * key on `app.user_id`, and a portal visitor has no user, so it correctly
 * returns nothing. `getDb()` is the owner connection, which bypasses RLS
 * entirely; on a page rendered for a stranger that would make one forgotten
 * predicate the difference between a public portal and an unannounced
 * product's backlog on a public URL.
 *
 * So this connects as `specboards_portal` (`infra/portal-role.sql`), a
 * read-only role granted eight tables and carrying role-targeted policies that
 * encode publication itself: an unpublished product, an unpublished stage and a
 * switched-off portal are refused by the database even when the query is wrong.
 *
 * Unlike `getAppDb()` there is no `asUser()` to remember. The policies are
 * data-driven rather than keyed on a session variable, so a query made through
 * this handle is already scoped to what is published. What it is NOT scoped to
 * is a single workspace: it can read the published rows of every workspace, and
 * deciding which portal a request is for stays the caller's job. That is a
 * deliberate split, and the failure modes are not comparable (see the migration
 * `0009_idea_portal_reader.sql`).
 *
 * Falls back the way `getWorkerDb()` does, and refuses for the same reason:
 * multi-tenant without the dedicated role would silently reinstate the owner
 * connection and the bypass with it. Single-tenant self-host keeps the
 * fallback, where there is no co-tenant to leak into. `null` in local file mode.
 */
export function getPortalDb(): Database | null {
  if (portalDb === undefined) {
    let url = process.env.DATABASE_URL_PORTAL;
    if (!url) {
      if (isMultiTenant() && process.env.DATABASE_URL) {
        throw new Error(
          "[security] getPortalDb: DATABASE_URL_PORTAL is required in multi-tenant mode; " +
            "refusing the owner-connection fallback, which would serve unpublished " +
            "rows to anonymous visitors (see infra/portal-role.sql).",
        );
      }
      url = process.env.DATABASE_URL;
    }
    portalDb = url ? createDb(url) : null;
  }
  return portalDb;
}
