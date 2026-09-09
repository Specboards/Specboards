-- Provision the dedicated `specboards_portal` role: the reader behind the
-- public Ideas portal and the public roadmap.
--
-- The portal serves people with no account and no membership, and every ideas
-- table is under RLS with a membership-scoped policy, so on the tenant role
-- (`specboards_app`) a visitor sees nothing at all. The alternative to this
-- role is reading on the owner connection, which bypasses RLS entirely and
-- would make one forgotten WHERE clause the difference between a public portal
-- and an unannounced product's backlog on a public URL. Migration
-- 0009_idea_portal_reader.sql carries the reasoning in full.
--
-- Runs ONCE per database (test, then prod) as a superuser / the table owner,
-- alongside infra/rls-role.sql and infra/worker-role.sql. Infrastructure, not a
-- schema migration: role creation needs CREATEROLE and the login password must
-- not land in git, so it lives here rather than in the drizzle journal. See
-- docs/RUNBOOK-db-role-cutover.md.
--
-- Idempotent: safe to re-run. It does NOT set a password or LOGIN; do that
-- separately (see the runbook) so no secret lands in git.
--
-- READ-ONLY, AND THAT IS LOAD-BEARING. Every grant below is SELECT. A public
-- submission and a public vote are writes, and they go through their own
-- intake path with their own quotas and validation, on a different connection.
-- This role exists to read published rows and cannot change one. A missing
-- grant is a much harder mistake to make than a subtly wrong policy, so the
-- grants are the primary bound here and the policies are the precision.

-- 1. The role. NOLOGIN until the operator sets a password out of band.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'specboards_portal') then
    create role specboards_portal nologin;
  end if;
end $$;

-- 2. Grants and policies.
--
-- Deliberately NOT written out here. They live in
-- `specboards_portal_apply_grants()`, created by migration
-- 0009_idea_portal_reader.sql, and this calls it.
--
-- The reason is an ordering problem this repo has already been bitten by. The
-- migration guards its grants on the role existing, so on a FRESH database it
-- runs first, finds nothing, and skips; the operator then runs this file and,
-- if the grants were only in the migration, the role would end up with none.
-- On an EXISTING database the role is already there and the migration applies
-- them. Two paths, two outcomes, and the difference is invisible until a
-- portal serves an empty page. `infra/worker-role.sql` records exactly this
-- happening to `workspace_tags`.
--
-- The obvious fix is to copy the grants into both files, which is what the
-- worker does and is why several of its grants carry an "also granted in
-- migration NNNN" comment: two copies that must be kept in step by hand. One
-- function called from both places cannot drift.
--
-- It is idempotent (DROP POLICY IF EXISTS before each CREATE), so it does not
-- matter which of the two runs second, and re-running this file stays safe as
-- the header promises.
--
-- If this errors with "function specboards_portal_apply_grants() does not
-- exist", the database has not had migration 0009 applied yet. Deploy first,
-- then run this: the app ships the migration, and this file only ever adds the
-- role the migration was waiting for.
select public.specboards_portal_apply_grants();

-- What that grants, so this file is still readable on its own: USAGE on the
-- schema, EXECUTE on the four publication predicates, and SELECT on exactly
-- workspaces, idea_settings, idea_portal_products, products, ideas,
-- idea_votes, releases and features. Anything not in that list is unreachable
-- by this role, so a portal query reaching for a table it has no business in
-- fails rather than returns.

-- 3. Nothing else, and keep it that way.
--
-- `infra/rls-role.sql` sets ALTER DEFAULT PRIVILEGES for specboards_app so new
-- tables are reachable without editing that file. Nothing of the sort is set
-- here, deliberately: a table added by a future migration must be granted to
-- this role on purpose, by somebody who has thought about whether a stranger on
-- the internet should be able to read it. Silence should mean "no" for the
-- public reader even when it means "yes" for the tenant role.
--
-- The trap this avoids is real and already documented in rls-role.sql: that
-- script re-grants "all tables in schema public" to specboards_app on every
-- run, and the runbook says re-running it is safe, so a revoke that lives only
-- in a migration silently comes undone. Because this file never issues a
-- blanket grant, there is nothing here to come undone.
--
-- Belt and braces on the read-only claim: revoke any write this role could have
-- picked up from a PUBLIC grant or an earlier version of this file. REVOKE is
-- harmless when there was nothing to revoke.
revoke insert, update, delete, truncate on all tables in schema public from specboards_portal;
revoke all on all sequences in schema public from specboards_portal;
