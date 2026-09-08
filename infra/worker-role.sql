-- Provision the dedicated `specboards_worker` role for background / ingestion
-- work: the outbox delivery drainer + relay, and the incoming GitHub webhook
-- sink. Today those run on the owner connection (`getDb()`), which bypasses RLS
-- entirely. Moving them onto this narrow, non-owner role means a bug in the
-- worker paths can only reach the handful of tables below, and RLS is a live
-- backstop on every other table (the role has no grant on auth, api_keys,
-- comments, activity_log, releases, ideas, saved_views, feature_links,
-- board_preferences, ... so it cannot read or write them at all). `members` is
-- readable but not writable: the notification fan-out has to know who is still
-- an active member and nothing more.
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
-- on specboards_is_member) would match zero rows for a non-owner role. We add a
-- role-targeted permissive policy per table below: `TO specboards_worker
-- USING (true)`. A role-targeted policy is only evaluated when the connected
-- role IS specboards_worker, so it grants this role cross-workspace access
-- without loosening anything for specboards_app or any other role. RLS stays
-- fully in force for the app role.

-- 1. The role. NOLOGIN until the operator sets a password out of band.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'specboards_worker') then
    create role specboards_worker nologin;
  end if;
end $$;

-- 2. Reach the schema. RLS + the grants below still gate every table.
grant usage on schema public to specboards_worker;

-- The RLS helper functions are SECURITY DEFINER; the worker policies use
-- literal `true` so they aren't needed, but grant EXECUTE for parity in case a
-- future worker query hits a policied read on a table it shares with the app.
grant execute on all functions in schema public to specboards_worker;

-- 3. Table privileges, scoped to exactly the tables the two worker paths touch
--    (see docs/RUNBOOK-db-role-cutover.md for the traced read/write surface).
--    Anything not listed here is unreachable by this role.

-- Outbound webhook delivery pipeline (drainer + relay).
grant select, update, delete            on outbox_events      to specboards_worker;
grant select, update                    on webhook_endpoints  to specboards_worker;
grant select, insert, update            on webhook_deliveries to specboards_worker;

-- Incoming GitHub webhook sink (github-sync reconcile).
grant select                            on github_app         to specboards_worker; -- no RLS (deployment singleton)
-- Delivery-id dedup, so a replayed (or GitHub-retried) delivery is processed
-- once. The INSERT is the check, so without this grant every delivery fails
-- rather than merely losing a row; also granted in migration 0061. DELETE is
-- for pruning past the retention window. No RLS (deployment singleton).
grant select, insert, delete            on github_webhook_deliveries to specboards_worker;
grant select, delete                    on github_installations to specboards_worker;
grant select, update                    on repositories       to specboards_worker;
grant select, insert, update, delete    on feature_github_links to specboards_worker;
grant select                            on workspace_levels   to specboards_worker;
grant select, insert, update, delete    on features           to specboards_worker;
grant select, insert, update, delete    on spec_index         to specboards_worker;
-- Sync records git-originated changes in the ledger. Insert and select only:
-- the worker appends history and never revises it, matching the append-only
-- trigger. Also granted in migration 0056, because this insert shares sync's
-- transaction and a missing grant would abort ingestion rather than merely
-- lose a row; see that migration for why it is in both places.
grant select, insert                    on item_events        to specboards_worker;
-- The pull request webhook is the only place that learns a proposed spec
-- change was merged or closed, so it is the only place that can tell the
-- author. Insert and select only: the worker raises notifications and never
-- reads or clears anyone's inbox. Also granted in migration 0058.
grant select, insert                    on notifications      to specboards_worker;
-- Sync canonicalises a spec's tags against the workspace registry and creates
-- any that are new (see `resolveTags`), so ingestion inserts here. Select and
-- insert only: the worker never renames or retires a tag. Also granted by the
-- migration that added the registry, which is why a database provisioned before
-- this line was added still has it and one provisioned after did not -- the
-- omission was only reachable on a fresh install, where the migration's own
-- grant is skipped because the role does not exist yet.
--
-- No role-targeted policy, deliberately: it matches what the migration did, and
-- adding one here would give the worker cross-workspace reach it has never had.
grant select, insert                    on workspace_tags     to specboards_worker;
grant select, insert, update            on products           to specboards_worker;
-- Sync resolves each repo's default product from its links (read-only).
grant select                            on product_repositories to specboards_worker;

-- Notification fan-out (relay). Resolving who to tell about an event needs to
-- know who is still an active member of the workspace: a departed or
-- deactivated person must not keep receiving an inbox. Select only, and no
-- write of any kind: the worker reads the roster and never edits it.
grant select                            on members            to specboards_worker;

-- Notification preferences (relay). Fan-out asks, per recipient and event
-- type, which channels they want it on: the workspace's defaults, then that
-- user's own overrides on top. Select only on both, and no write of any kind:
-- the worker reads somebody's settings to honour them and never records an
-- answer on their behalf. Also granted in migration 0002, so an existing
-- database honours preferences the moment that migration lands rather than
-- when this file is next re-run by hand.
grant select                            on notification_defaults    to specboards_worker;
grant select                            on notification_preferences to specboards_worker;

-- Watchers (relay). Read to resolve who a change concerns, and written to
-- record an auto-watch when somebody is assigned an item, comments on one, or
-- creates one. The one write in the notification path, and deliberately no
-- DELETE: the worker can add somebody to an item they just acted on, and can
-- never undo a decision a person made about their own attention. The
-- assignment case is why this lives here at all rather than at the write site,
-- where the acting user is not the user being subscribed. Also granted in
-- migration 0003.
grant select, insert, update             on item_watchers to specboards_worker;

-- Product access (relay). Resolving who to tell about a change to an item in a
-- private product needs to know who may read that product: a workspace member
-- who is not a member of the product cannot see the item, so telling them is
-- an in-app row they can never open and an email whose body leaks the title of
-- work they were deliberately not given access to. Select only, and no write:
-- the worker reads the roster to honour it and can no more edit who may see a
-- product than it can edit who belongs to a workspace. Also granted in
-- migration 0007.
grant select                            on product_members    to specboards_worker;

-- Read-only context both paths need to build envelopes / resolve scope.
grant select                            on workspaces         to specboards_worker;
grant select                            on users              to specboards_worker; -- no RLS

-- Sequences behind any INSERT the role performs.
grant usage, select on all sequences in schema public to specboards_worker;

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
    'product_repositories', 'workspaces', 'item_events', 'notifications',
    'members', 'notification_defaults', 'notification_preferences',
    'item_watchers', 'product_members'
  ];
begin
  foreach t in array worker_tables loop
    execute format('drop policy if exists %I on %I', t || '_worker_all', t);
    execute format(
      'create policy %I on %I for all to specboards_worker using (true) with check (true)',
      t || '_worker_all', t
    );
  end loop;
end $$;

-- 5. Future tables created by the migration owner do NOT auto-grant to this
--    role (unlike specboards_app): the worker surface is deliberately fixed. If a
--    later migration adds a table a worker path must touch, extend this file and
--    re-run it on both databases (the runbook covers this).
