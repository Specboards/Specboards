import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `specboards_worker` role's read surface, checked against the tables the
 * worker paths actually touch.
 *
 * Regression cover for a production outage that produced no visible error: the
 * GitHub sync worker calls `resolveRepoDefaultProduct`, which reads
 * `product_repositories`, and the role had neither SELECT on that table nor a
 * role-targeted policy for it. Every spec push aborted mid-reconcile, so merged
 * spec edits silently never reached the board.
 *
 * `infra/worker-role.sql` already granted it. That file is applied by hand, and
 * production was last run against a version predating the line, so exactly one
 * table drifted out of the set the code assumes. This suite exists so the next
 * table a worker path starts reading cannot drift the same way: apply the file,
 * then assert every table the worker reads is actually reachable.
 *
 * Needs a migrated Postgres at DATABASE_URL, and rights to create a role;
 * skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * Tables the worker paths read, each tied to the call site that needs it.
 * Extend this when a worker path starts touching a new table, and the grant in
 * `infra/worker-role.sql` has to follow.
 */
const WORKER_READS: { table: string; why: string }[] = [
  {
    table: "repositories",
    why: "resolveRepositories: find connections for a push",
  },
  { table: "features", why: "syncRepository: upsert synced specs" },
  { table: "spec_index", why: "syncRepository: blobSha drift detection" },
  { table: "products", why: "syncRepository: land specs in a product" },
  {
    table: "product_repositories",
    why: "resolveRepoDefaultProduct: the repo's default product",
  },
  { table: "workspace_levels", why: "syncRepository: resolve the leaf level" },
  { table: "workspaces", why: "envelope / scope context" },
  { table: "users", why: "envelope / scope context" },
  {
    table: "github_installations",
    why: "resolveRepoClient: mint an install token",
  },
  { table: "github_app", why: "resolveRepoClient: app credentials" },
  {
    table: "github_webhook_deliveries",
    why: "claimDelivery: process a delivery once",
  },
  {
    table: "feature_github_links",
    why: "pull_request events: refresh link state",
  },
  { table: "item_events", why: "sync appends git-originated history" },
  { table: "notifications", why: "review-outcome notifications" },
  { table: "outbox_events", why: "webhook drainer" },
  { table: "webhook_endpoints", why: "webhook drainer" },
  { table: "webhook_deliveries", why: "webhook relay" },
];

describe.skipIf(!DB_URL)("specboards_worker read surface", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    // Apply the role definition exactly as an operator would. It is written to
    // be idempotent, so running it here is safe and also proves it still runs.
    const file = join(process.cwd(), "..", "..", "infra", "worker-role.sql");
    await sql.unsafe(readFileSync(file, "utf8"));
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it.each(WORKER_READS)("can read $table ($why)", async ({ table }) => {
    const [row] = await sql`
      select has_table_privilege('specboards_worker', ${table}, 'SELECT') as ok`;
    expect(row!.ok).toBe(true);
  });

  it("has a role-targeted policy on every RLS table it reads", async () => {
    // A grant alone is not enough: these tables carry RLS, and the worker runs
    // with no `app.user_id`, so a member-scoped policy never matches for it.
    const missing: string[] = [];
    for (const { table } of WORKER_READS) {
      const [rls] = await sql`
        select relrowsecurity as on from pg_class where relname = ${table}`;
      if (!rls?.on) continue;
      const [pol] = await sql`
        select count(*)::int as n from pg_policy p
        join pg_class c on c.oid = p.polrelid
        where c.relname = ${table}
          and 'specboards_worker' = any (
            select pg_get_userbyid(r) from unnest(p.polroles) r)`;
      if (!pol || pol.n === 0) missing.push(table);
    }
    expect(missing).toEqual([]);
  });

  it("can run the query whose missing grant broke spec sync", async () => {
    // The literal failure: resolveRepoDefaultProduct, run as the worker.
    await sql.begin(async (tx) => {
      await tx`set local role specboards_worker`;
      const rows = await tx`
        select product_id from product_repositories where is_default = true limit 1`;
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
