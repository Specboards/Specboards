/**
 * Standalone migration runner, executed as the Fly `release_command` before a
 * new version takes traffic (and usable by hand for a self-host upgrade).
 *
 * Why this exists: the deploy pipeline had no migration step, so schema changes
 * were applied by hand against each database ahead of each deploy. That leaves
 * a window where the new code is live and the column it needs is not, and the
 * window is easy to lose because pushing to main deploys the test app
 * automatically. A release_command closes it: Fly runs this in a one-off
 * machine on the new image and aborts the release if it exits non-zero, so a
 * failed migration means the old version keeps serving.
 *
 * It is bundled into a single file at build time (see infra/web.Dockerfile), so
 * it carries no dependency on the runtime image's node_modules layout.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Where the SQL files and their journal live inside the runtime image. The repo
 * keeps them in infra/migrations (drizzle.config.ts `out`); the Dockerfile
 * copies that directory next to this script.
 */
const MIGRATIONS_FOLDER = process.env.MIGRATIONS_FOLDER ?? "./migrations";

/**
 * Key for the advisory lock below. Any constant works as long as every deploy
 * uses the same one. Kept a plain number (not a bigint) because postgres-js
 * types its template parameters as serializable values; it sits inside
 * Number.MAX_SAFE_INTEGER, so it survives the round trip to `bigint` intact.
 */
const LOCK_KEY = 8_073_216_559_204_147;

/**
 * Migrations need DDL rights, which the app's RLS-scoped role may not have.
 * MIGRATE_DATABASE_URL lets an operator point the release step at an owner
 * connection without changing what the app itself connects as.
 */
function connectionString(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "MIGRATE_DATABASE_URL or DATABASE_URL must be set to run migrations.",
    );
  }
  return url;
}

/**
 * How many migrations the journal records as applied.
 *
 * Zero when the journal does not exist yet, which is the state of every
 * database before its first migration: "no table" and "no rows" mean the same
 * thing here, and conflating them is what made the first run, the one that
 * builds all 63 tables, report "schema up to date" and tell the operator
 * nothing had happened. Postgres raises 3F000 for the missing schema and 42P01
 * for a missing table; both are the empty case.
 *
 * Any other failure returns null, which degrades the summary line to a vaguer
 * one rather than failing a migration that otherwise succeeded.
 */
async function appliedCount(sql: postgres.Sql): Promise<number | null> {
  try {
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
    `;
    return Number(rows[0]?.count ?? 0);
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code === "3F000" || code === "42P01" ? 0 : null;
  }
}

async function main(): Promise<void> {
  const sql = postgres(connectionString(), {
    // A release machine runs one short task: a single connection, no pooling
    // games, and `max_lifetime: 0` so a long migration is never recycled
    // mid-statement.
    max: 1,
    prepare: false,
    max_lifetime: 0,
    idle_timeout: 0,
    connect_timeout: 30,
    onnotice: () => {},
  });

  try {
    // Two machines releasing at once (a retried deploy, or test and prod
    // sharing a database by mistake) would otherwise both try to apply the same
    // migration. The session lock makes the second wait for the first, then
    // find nothing left to do.
    await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
    const started = Date.now();
    // Count the journal either side so the summary can distinguish "created
    // the whole schema" from "there was nothing to do". Reporting "schema up
    // to date" for both is how a first-time self-hoster watched 63 tables get
    // created and could not tell whether anything had happened.
    const before = await appliedCount(sql);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await appliedCount(sql);
    const applied = after !== null && before !== null ? after - before : null;
    const summary =
      applied === null
        ? "schema up to date"
        : applied === 0
          ? "already up to date, nothing to apply"
          : `applied ${applied} migration${applied === 1 ? "" : "s"}`;
    process.stdout.write(`[migrate] ${summary} in ${Date.now() - started}ms\n`);
  } finally {
    // Best-effort unlock; ending the session releases it anyway.
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // Exit non-zero so Fly aborts the release and the previous version keeps
  // serving, rather than promoting code whose schema never landed.
  process.stderr.write(
    `[migrate] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
