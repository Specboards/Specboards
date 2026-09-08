-- Provision the non-owner `specboards_app` role that RLS actually enforces
-- against. The app connects as the table owner today, so the RLS policies in
-- migrations 0002 / 0012 (and later) are dead weight: the owner bypasses RLS.
-- Connecting as this non-owner role turns those policies into a real database
-- backstop behind the app-code workspaceId filters.
--
-- Run ONCE per database (test, then prod) as a superuser / the role that owns
-- the tables. This is infrastructure, not a schema migration, so it lives here
-- rather than in the drizzle journal: creating a role needs CREATEROLE, and the
-- login password must not be committed. See docs/RUNBOOK-db-role-cutover.md.
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

-- 2b. Tables the tenant role must NOT reach, revoked after the blanket grant
--     above rather than by omitting them from it.
--
--     `mail_settings` holds the transport and credentials every transactional
--     message leaves through. A tenant connection able to read it learns the
--     relay and the sender; able to write it, one workspace owner could
--     re-point every other tenant's verification links and invitations at a
--     relay they control. It carries no workspace_id and no RLS because it is
--     deployment configuration, so there is nothing for a policy to key on and
--     the grant is the whole of the access control. It is reached on the owner
--     connection only (see `lib/mail/config.ts`).
--
--     This has to live here, not only in migration 0004. That migration
--     revokes it too, for a database that has already been provisioned, but
--     this script re-grants "all tables in schema public" every time it runs
--     and the runbook says re-running it is safe. Without this line the revoke
--     would silently come undone the next time somebody followed that advice.
--     Caught by `apps/web/src/lib/mail/settings.int.test.ts`, which applies
--     this file and then checks the privilege.
revoke all on mail_settings from specboards_app;

--     `bootstrap_secret` holds the hash of the token that lets somebody claim
--     an unclaimed instance. It is deployment configuration reached on the
--     owner connection, and it carries no workspace_id for a policy to key on,
--     so the grant is the whole of the access control.
--
--     This has to live here, not only in the migration that creates the table.
--     This script re-grants "all tables in schema public" every time it runs,
--     and the runbook says re-running it is safe, so a revoke that lived only
--     in a migration would come undone the next time somebody followed that
--     advice.
revoke all on bootstrap_secret from specboards_app;

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
