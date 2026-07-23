import { createDb, type Database } from "@specboards/db";

import { isMultiTenant } from "@/lib/tenancy";

let db: Database | null | undefined;

/**
 * Drizzle client for the web app, resolved once per process. Gated on
 * `DATABASE_URL` (mirrors `getStore()` / `getAuth()`): `null` in local file
 * mode, where there is no Postgres and auth/workspaces are disabled.
 */
export function getDb(): Database | null {
  if (db === undefined) {
    const url = process.env.DATABASE_URL;
    db = url ? createDb(url) : null;
  }
  return db;
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
