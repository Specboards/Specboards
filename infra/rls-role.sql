-- Provision the non-owner `specboards_app` role that RLS actually enforces
-- against. The app connects as the table owner today, so the RLS policies in
-- migrations 0002 / 0012 (and later) are dead weight: the owner bypasses RLS.
-- Connecting as this non-owner role turns those policies into a real database
-- backstop behind the app-code workspaceId filters.
--
-- Run ONCE per database (test, then prod) as a superuser / the role that owns
-- the tables. This is infrastructure, not a schema migration, so it lives here
-- rather than in the drizzle journal: creating a role needs CREATEROLE, and the
-- login password must not be committed. See docs/PLAN-rls-role-cutover.md.
--
-- Idempotent: safe to re-run. It does NOT set a password or LOGIN; do that
-- separately (see the runbook) so no secret lands in git.

-- 1. The role. NOLOGIN until the operator sets a password out of band.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'specboards_app') then
    create role specboards_app nologin;
  end if;
end $$;

-- 2. Schema + object privileges. RLS still gates every row; these grants just
--    let the role reach the tables at all. SELECT on the Better Auth tables
--    (users, sessions, ...) is intentional: the store reads `users` for
--    assignee display names and membership validation. Those tables carry no
--    RLS and are never written through this connection.
--
--    NOTE (2026-07-03): the live test/prod clusters predate this script and
--    use a `writer` group role (specboards_app is a member) with per-table
--    grants on the tenant tables only. Auth tables were NOT granted there,
--    which made the PR #75 assignee validation 500 (42501 on `users`); fixed
--    with `grant select on users to writer;` on both DBs. If a store query
--    ever touches another auth table (sessions, accounts, api_keys), grant it
--    to `writer` the same way.
grant usage on schema public to specboards_app;
grant select, insert, update, delete on all tables in schema public to specboards_app;
grant usage, select on all sequences in schema public to specboards_app;
-- The RLS helper functions are SECURITY DEFINER (run as owner), so the role
-- only needs EXECUTE, not direct read access to members/products.
grant execute on all functions in schema public to specboards_app;

-- 3. Future objects created by the migration owner inherit the same grants, so
--    a new table added in a later migration is reachable without editing this
--    script. Applies to objects created by the role running this statement, so
--    run migrations as that same owner (see the versioning/migration runbook).
alter default privileges in schema public
  grant select, insert, update, delete on tables to specboards_app;
alter default privileges in schema public
  grant usage, select on sequences to specboards_app;
alter default privileges in schema public
  grant execute on functions to specboards_app;
