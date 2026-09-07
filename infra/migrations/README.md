# Migrations

`0000_baseline.sql` is the whole schema as of v1.0.2. The 81 files it replaced
are in git history before that release.

## Adding a migration

Write the SQL by hand, in a new file, and add an entry to `meta/_journal.json`
with a `when` larger than every entry already there. That is the whole process.

**Do not run `drizzle-kit generate`.** Drizzle's schema
(`packages/db/src/schema.ts`) describes tables and nothing else, so it cannot
express the row-level security policies that are most of what these files do:
generating from it produces all 65 tables and zero of the 87 policies. The SQL
here is authoritative wherever Drizzle cannot express a constraint, which is why
the `generate` script was removed rather than left as something that looks
available. Keep `schema.ts` in step by hand so the app's queries stay typed.

## How the runner decides what to apply

`packages/db/src/migrate.ts` runs everything in `meta/_journal.json` that the
database has not recorded, in one transaction, behind an advisory lock.

Drizzle decides purely by timestamp: it applies a migration only when the newest
`created_at` in `drizzle.__drizzle_migrations` is older than that file's `when`.
Nothing compares hashes, and nothing notices a file that has changed.

That is what makes the baseline safe on an existing database. It carries the
`when` the original `0000` had (1781031491546), and any database that ran the old
history is at 1787500000000, so the comparison is never true and the baseline is
never applied there.

## The state that would have broken silently

A database left part-way through the old history is *newer* than the baseline by
that comparison, so the baseline is skipped, and the migrations it still needs no
longer exist here. Measured on a database stopped at `0040`: 46 tables and 47
policies where there should be 65 and 87, reported as "already up to date,
nothing to apply", release successful.

`assertNotBehindBaseline` in the runner refuses that case instead. Any database
with migration rows must already contain a table the baseline has
(`public.user_avatars`, from the last migration before the squash), or the run
fails without writing anything and says how to recover: migrate it to the end
from v1.0.1 or earlier first, then upgrade.

## Regenerating the baseline

`scripts/generate-migration-baseline.sh` applies whatever is in this folder to a
scratch database and dumps the result. It is generated through Postgres, not by
concatenating files and not from `schema.ts`, because the realised schema is the
only source that has the policies, functions and triggers as well as the tables.

Diff the result against a database built from the previous history before
committing it. The script checks what it can (that every `SECURITY DEFINER`
function still pins a `search_path`, that `check_function_bodies` survived), but
those checks exist because the first attempt at this file lost six `search_path`
pins, and only a real diff caught it.
