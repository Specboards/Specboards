-- Provision the dedicated `specboard_worker` role for background / ingestion
-- work: the outbox delivery drainer + relay, and the incoming GitHub webhook
-- sink. Today those run on the owner connection (`getDb()`), which bypasses RLS
-- entirely. Moving them onto this narrow, non-owner role means a bug in the
-- worker paths can only reach the handful of tables below, and RLS is a live
-- backstop on every other table (the role has no grant on auth, api_keys,
-- members, comments, activity_log, releases, ideas, saved_views, feature_links,
-- board_preferences, ... so it cannot read or write them at all).
--
-- Runs ONCE per database (test, then prod) as a superuser / the table owner,
-- alongside infra/rls-role.sql. Infrastructure, not a schema migration: role
-- creation needs CREATEROLE and the login password must not land in git, so it
-- lives here rather than in the drizzle journal. See
-- docs/RUNBOOK-db-role-cutover.md.
--
-- Idempotent: safe to re-run. It does NOT set a password or LOGIN; do that
-- separately (see the runbook) so no secret lands in git.
--
-- CROSS-WORKSPACE ACCESS. The drainer/relay/sink span every workspace and run
-- with no `app.user_id` set, so the existing `*_member_all` policies (which key
-- on specboard_is_member) would match zero rows for a non-owner role. We add a
-- role-targeted permissive policy per table below: `TO specboard_worker
-- USING (true)`. A role-targeted policy is only evaluated when the connected
-- role IS specboard_worker, so it grants this role cross-workspace access
-- without loosening anything for specboard_app or any other role. RLS stays
-- fully in force for the app role.

-- 1. The role. NOLOGIN until the operator sets a password out of band.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'specboard_worker') then
    create role specboard_worker nologin;
  end if;
end $$;

-- 2. Reach the schema. RLS + the grants below still gate every table.
grant usage on schema public to specboard_worker;

-- The RLS helper functions are SECURITY DEFINER; the worker policies use
-- literal `true` so they aren't needed, but grant EXECUTE for parity in case a
-- future worker query hits a policied read on a table it shares with the app.
grant execute on all functions in schema public to specboard_worker;

-- 3. Table privileges, scoped to exactly the tables the two worker paths touch
--    (see docs/RUNBOOK-db-role-cutover.md for the traced read/write surface).
--    Anything not listed here is unreachable by this role.

-- Outbound webhook delivery pipeline (drainer + relay).
grant select, update, delete            on outbox_events      to specboard_worker;
grant select, update                    on webhook_endpoints  to specboard_worker;
grant select, insert, update            on webhook_deliveries to specboard_worker;

-- Incoming GitHub webhook sink (github-sync reconcile).
grant select                            on github_app         to specboard_worker; -- no RLS (deployment singleton)
grant select, delete                    on github_installations to specboard_worker;
grant select, update                    on repositories       to specboard_worker;
grant select, insert, update, delete    on feature_github_links to specboard_worker;
grant select                            on workspace_levels   to specboard_worker;
grant select, insert, update, delete    on features           to specboard_worker;
grant select, insert, update, delete    on spec_index         to specboard_worker;
grant select, insert, update            on products           to specboard_worker;
-- Sync resolves each repo's default product from its links (read-only).
grant select                            on product_repositories to specboard_worker;

-- Read-only context both paths need to build envelopes / resolve scope.
grant select                            on workspaces         to specboard_worker;
grant select                            on users              to specboard_worker; -- no RLS

-- Sequences behind any INSERT the role performs.
grant usage, select on all sequences in schema public to specboard_worker;

-- 4. Role-targeted permissive policies granting cross-workspace access to the
--    RLS-enabled tables above (users + github_app carry no RLS, so no policy).
--    `create policy` has no IF NOT EXISTS, so drop-then-create for idempotency.
do $$
declare
  t text;
  worker_tables text[] := array[
    'outbox_events', 'webhook_endpoints', 'webhook_deliveries',
    'github_installations', 'repositories', 'feature_github_links',
    'workspace_levels', 'features', 'spec_index', 'products',
    'product_repositories', 'workspaces'
  ];
begin
  foreach t in array worker_tables loop
    execute format('drop policy if exists %I on %I', t || '_worker_all', t);
    execute format(
      'create policy %I on %I for all to specboard_worker using (true) with check (true)',
      t || '_worker_all', t
    );
  end loop;
end $$;

-- 5. Future tables created by the migration owner do NOT auto-grant to this
--    role (unlike specboard_app): the worker surface is deliberately fixed. If a
--    later migration adds a table a worker path must touch, extend this file and
--    re-run it on both databases (the runbook covers this).
