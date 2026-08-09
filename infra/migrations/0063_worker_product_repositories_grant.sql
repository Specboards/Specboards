-- Let the GitHub sync worker read product_repositories.
--
-- Every spec push to a connected repo has been failing in production:
--
--   [webhooks/github] sync failed for Specboards/Specs (workspace ...):
--     Failed query: select "product_id" from "product_repositories"
--       where repo_id = $1 and is_default = $2
--     routine: 'aclcheck_error'
--
-- `syncRepository` calls `resolveRepoDefaultProduct` to decide which product a
-- synced spec lands in. That read runs on the worker connection
-- (DATABASE_URL_WORKER), and `specboards_worker` had neither SELECT on
-- `product_repositories` nor a role-targeted policy on it, so the whole
-- reconcile aborted. Nothing downstream ran: spec bodies, titles and blob shas
-- stayed at whatever the last successful sync left, so a merged spec edit
-- simply never appeared on the board. The failure is caught and logged inside
-- the webhook handler, so GitHub sees a 2xx and nobody is told.
--
-- `infra/worker-role.sql` already grants this and already lists
-- `product_repositories` among the worker policy tables. That file is applied
-- by hand, though (see its section 5, and the role-cutover runbook), and it was
-- last run against production before that line was added. Exactly one table
-- drifted; every other grant in the file is present.
--
-- So this repeats the grant here for the same reason 0056, 0058 and 0061 do:
-- worker-role.sql stays the readable source of truth for the role's surface,
-- and repeating the load-bearing parts in a migration means a deploy cannot
-- leave a worker path broken. This one is load-bearing in the strongest sense,
-- because the missing read aborts ingestion rather than losing a row.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
    GRANT SELECT ON "product_repositories" TO specboards_worker;

    -- Sync spans every workspace and runs with no `app.user_id`, so the
    -- member-scoped select policy on this table never matches for the worker.
    -- A role-targeted policy is only evaluated when the connected role IS
    -- specboards_worker, so this loosens nothing for specboards_app.
    DROP POLICY IF EXISTS product_repositories_worker_all ON "product_repositories";
    CREATE POLICY product_repositories_worker_all ON "product_repositories"
      FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
  END IF;
END $$;
