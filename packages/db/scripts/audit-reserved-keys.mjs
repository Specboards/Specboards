#!/usr/bin/env node
/**
 * Report existing products whose key a route already shadows.
 *
 * A product is addressed at `/{org}/{key}/…`, and Next resolves a static
 * segment before the `[product]` dynamic one. So a product keyed `settings`,
 * `dashboard`, `notifications` or `repositories` is unreachable: every link to
 * it lands on that other page instead.
 *
 * `productKeyFromName` now refuses to mint those keys, but that only helps
 * products created afterwards. Any product that already holds one was created
 * under the old rules and is broken today, silently: no error, no clue, just a
 * board that never opens. This is the only way to find them.
 *
 * `ideas` is in the list ahead of the public portal's routes existing. A
 * product already holding it is not broken yet and will be the moment the
 * portal ships, which is the useful time to know.
 *
 * Lives in @specboards/db rather than scripts/ because that is where the
 * `postgres` dependency is, alongside the migration runner it complements.
 *
 * Read-only. It prints what it finds and changes nothing: renaming somebody's
 * product is a conversation with them, not a migration.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm audit:slugs
 *
 * Against a Fly database, tunnel first:
 *   fly proxy 15432:5432 -a specboard-test-db
 *   DATABASE_URL=postgres://...@localhost:15432/... pnpm audit:slugs
 */

import { RESERVED_PRODUCT_KEYS } from "@specboards/core";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "[key-audit] DATABASE_URL is not set. Point it at the database to check.",
  );
  process.exit(2);
}

const reserved = [...RESERVED_PRODUCT_KEYS];
const sql = postgres(url, { prepare: false, max: 1 });

try {
  const rows = await sql`
    select p.id, p.key, p.name, w.slug as org
    from products p
    join workspaces w on w.id = p.workspace_id
    where p.key in ${sql(reserved)}
    order by w.slug, p.key`;

  if (rows.length === 0) {
    console.log(
      `[key-audit] clean: no product holds any of the ${reserved.length} reserved keys.`,
    );
    process.exit(0);
  }

  // Loud, and non-zero. Each of these is a product somebody cannot open.
  console.error(`[key-audit] ${rows.length} product(s) hold a reserved key:\n`);
  for (const row of rows) {
    const shadowed = `/${row.org}/${row.key}`;
    console.error(
      `  ${row.key.padEnd(16)} ${row.name.padEnd(24)} ${shadowed}  (${row.id})`,
    );
  }
  console.error(
    "\n[key-audit] Each is shadowed by the route of the same name and cannot be\n" +
      "            opened. Rename the product (which re-mints its key) or change\n" +
      "            the key directly. `ideas` is not broken until the public\n" +
      "            portal ships, but will be.",
  );
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
