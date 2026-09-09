#!/usr/bin/env node
/**
 * Report existing workspaces whose slug is now reserved.
 *
 * Widening `RESERVED_ORG_SLUGS` only protects workspaces created afterwards.
 * Every slug already in a database was accepted under the older, shorter list,
 * so the code change and the question "is anybody already sitting on one of
 * these?" are two different things, and only the second can hurt somebody.
 *
 * It matters because the new entries are subdomains. Until the public portal
 * ships, a workspace slugged `app` is a cosmetic oddity in a URL path. The
 * moment `*.specboards.ai` is wildcarded, that same row means a customer's
 * portal answers on `app.specboards.ai`, which is the production application.
 * So this wants running BEFORE the wildcard goes live, on test and then prod.
 *
 * A script rather than a SQL snippet in the runbook because the list it checks
 * against lives in TypeScript and changes: a query pasted into a document is
 * one that silently stops matching the code the first time somebody adds an
 * entry. This imports the real set.
 *
 * Lives in @specboards/db rather than scripts/ because that is where the
 * `postgres` dependency is, alongside the migration runner it complements.
 *
 * Read-only. It prints what it finds and changes nothing: what to do about a
 * collision (rename the workspace, or refuse to serve a portal on that slug)
 * is a conversation with the customer, not a migration.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm audit:slugs
 *
 * Against a Fly database, tunnel first:
 *   fly proxy 15432:5432 -a specboard-test-db
 *   DATABASE_URL=postgres://...@localhost:15432/... pnpm audit:slugs
 */

import postgres from "postgres";

import { RESERVED_ORG_SLUGS } from "@specboards/core";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "[slug-audit] DATABASE_URL is not set. Point it at the database to check.",
  );
  process.exit(2);
}

const reserved = [...RESERVED_ORG_SLUGS];
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const rows = await sql`
    select id, name, slug from workspaces
    where slug in ${sql(reserved)}
    order by slug`;

  if (rows.length === 0) {
    console.log(
      `[slug-audit] clean: no workspace holds any of the ${reserved.length} reserved slugs.`,
    );
    process.exit(0);
  }

  // Loud, and non-zero: this is a release blocker for the wildcard, not a note.
  console.error(
    `[slug-audit] ${rows.length} workspace(s) hold a now-reserved slug:\n`,
  );
  for (const row of rows) {
    console.error(`  ${row.slug.padEnd(20)} ${row.name}  (${row.id})`);
  }
  console.error(
    "\n[slug-audit] Each of these becomes a hostname once *.specboards.ai is\n" +
      "             wildcarded. Resolve them (rename the workspace, or refuse a\n" +
      "             portal on that slug) BEFORE the wildcard goes live.",
  );
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
