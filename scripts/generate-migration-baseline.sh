#!/usr/bin/env bash
#
# Regenerate infra/migrations/0000_baseline.sql from the migrations in the tree.
#
# The baseline is the realised schema of a database that has run every migration
# in infra/migrations, dumped back out as SQL. It is deliberately NOT built two
# other ways that look reasonable:
#
#   - Not by concatenating the migration files. That replays a diary of tables
#     built, rewritten and dropped again, which is the thing a baseline exists
#     to stop replaying.
#
#   - Not from packages/db/src/schema.ts. Drizzle's schema describes tables and
#     nothing else, so `drizzle-kit generate` produces all 65 tables and zero of
#     the 87 row-level security policies. That is not a thinner baseline, it is
#     a fresh install with tenant isolation switched off.
#
# Postgres is the only source that has all of it, so the dump goes through a
# real database.
#
# Usage:
#   scripts/generate-migration-baseline.sh [postgres-url]
#
# The URL defaults to a local server and is used only to CREATE and DROP a
# scratch database; nothing else is touched. Requires pg_dump matching the
# server's major version.
#
# After running, diff the result against a database built from the old history
# before committing. `git stash` the new baseline, migrate a scratch database
# from the old files, restore, migrate another from the baseline, and
# `pg_dump --schema-only` both. They must be identical; the last time this was
# done by eye instead, six SECURITY DEFINER functions silently lost their
# `SET search_path` pin.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${1:-postgres://postgres:postgres@localhost:5432/postgres}"
SCRATCH_DB="specboards_baseline_$$"
OUT="$ROOT/infra/migrations/0000_baseline.sql"

# Swap the database name in the URL, leaving credentials and host alone.
scratch_url() {
  python3 - "$ADMIN_URL" "$SCRATCH_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
parts = urlsplit(sys.argv[1])
print(urlunsplit(parts._replace(path="/" + sys.argv[2])))
PY
}

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> creating scratch database $SCRATCH_DB"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SCRATCH_DB\";"

echo "==> applying infra/migrations"
DATABASE_URL="$(scratch_url)" pnpm --filter @specboards/db migrate

echo "==> dumping the realised schema"
RAW="$(mktemp)"
pg_dump "$(scratch_url)" --schema-only --no-owner --no-privileges -n public > "$RAW"

echo "==> cleaning the dump into a migration"
python3 - "$RAW" "$OUT" <<'PY'
import re, sys

raw_path, out_path = sys.argv[1], sys.argv[2]
raw = open(raw_path).read()

# Session settings pg_dump makes for itself are written at column 0 and
# terminated. A function's own `SET search_path TO 'public'` is an INDENTED
# attribute of CREATE FUNCTION with no semicolon, and stripping that would turn
# every SECURITY DEFINER function into a privilege-escalation vector. Anchoring
# on the raw line rather than a stripped one is what keeps the two apart.
SESSION_SET = re.compile(
    r"^SET (statement_timeout|lock_timeout|idle_in_transaction_session_timeout"
    r"|client_encoding|standard_conforming_strings|xmloption|client_min_messages"
    r"|row_security|default_tablespace|default_table_access_method|search_path)\b.*;$"
)

kept = []
for line in raw.split("\n"):
    # psql meta-commands, which pg_dump 16.14+ brackets its output with. Not SQL.
    if line.startswith("\\restrict") or line.startswith("\\unrestrict"):
        continue
    if SESSION_SET.match(line):
        continue
    if line.startswith("SELECT pg_catalog.set_config("):
        continue
    # `public` exists on every Postgres, and re-commenting it needs rights a
    # managed instance may not grant.
    if line == "CREATE SCHEMA public;" or line.startswith("COMMENT ON SCHEMA public"):
        continue
    # Version banners would make the file churn on every contributor's machine.
    if line.startswith("-- Dumped from database version") or line.startswith("-- Dumped by pg_dump version"):
        continue
    kept.append(line)

body = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip() + "\n"

# `check_function_bodies = false` is load-bearing, not leftover noise: pg_dump
# writes functions in name order, so a body that calls another function is
# created before its callee exists. Without it the file dies partway through.
if "SET check_function_bodies = false;" not in body:
    sys.exit("refusing to write: the dump lost SET check_function_bodies")

# Count declarations, not the words. `SECURITY DEFINER` appears in a comment
# explaining why one of these functions validates its arguments, and counting
# that as a seventh function made this check refuse a correct baseline.
secdef = len(re.findall(r"^\s+LANGUAGE .*\bSECURITY DEFINER\b", body, re.M))
pinned = len(re.findall(r"^\s+SET search_path TO ", body, re.M))
if secdef and pinned < secdef:
    sys.exit(
        f"refusing to write: {secdef} SECURITY DEFINER functions but only "
        f"{pinned} pin a search_path. An unpinned one is a privilege-escalation "
        f"vector; the last time this happened the cleaning step had eaten the "
        f"pins as if they were session settings."
    )

header = open(out_path).read()
marker = "--\n-- PostgreSQL database dump"
if marker not in header:
    sys.exit("refusing to write: existing baseline has no recognisable header")
open(out_path, "w").write(header[: header.index(marker)] + body)
print(f"wrote {out_path}: {body.count(chr(10))} lines, "
      f"{secdef} SECURITY DEFINER functions, {pinned} search_path pins")
PY

rm -f "$RAW"
echo "==> done. Diff against a database built from the previous history before committing."
