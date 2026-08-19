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
 * omits it reads every tenant's rows. That is true today of the model-provider,
 * usage, assistant and skills tables, whose migrations (0067, 0068, 0070, 0074)
 * carry policies written as though they applied here. They do not. The
 * predicates are all present, which is why this is a sharp edge rather than a
 * defect, and why it is written down here rather than left to be rediscovered.
 *
 * ── Moving a path onto the RLS-enforced connection ──────────────────────────
 * Worth doing, and not a search-and-replace. Two things bite:
 *
 * 1. A policy that is org-admin-only for SELECT will return no rows inside an
 *    ordinary member's request. `resolveConfig` in `model-provider-service.ts`
 *    reads `model_provider_credentials.secret` on exactly that path, and the
 *    policy is org-admin only, so the move would resolve `apiKey` to null and
 *    fail every non-admin's assistant call against a keyed endpoint, with
 *    nothing in the response to say why. Such a read needs a SECURITY DEFINER
 *    function or a connection that stays privileged.
 * 2. The app role needs the table grant. `infra/rls-role.sql` grants future
 *    tables by default, but the live test and prod clusters predate it and use
 *    per-table grants (see the notes in 0067).
 *
 * `owner-connection-rls.int.test.ts` pins both, so a future move fails a test
 * rather than a customer's request.
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
