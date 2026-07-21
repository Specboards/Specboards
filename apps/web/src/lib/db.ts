import { createDb, type Database } from "@specboard/db";

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
 * When `DATABASE_URL_WORKER` is unset the workers fall back to the owner
 * connection, preserving today's behavior until the role is provisioned per
 * environment (see docs/RUNBOOK-db-role-cutover.md). Like `getDb()`, this is
 * `null` in local file mode where there is no Postgres.
 */
export function getWorkerDb(): Database | null {
  if (workerDb === undefined) {
    const url = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
    workerDb = url ? createDb(url) : null;
  }
  return workerDb;
}
