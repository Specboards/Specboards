-- Let the ingestion worker append to the change ledger.
--
-- Sync reconciles specs from git and writes the `features` row directly. Those
-- are real changes to an item (a spec renamed in an editor, a file moved, a
-- body rewritten) and until now they left no trace in the change log, so a
-- spec-backed item's history was missing most of what happened to it.
--
-- ── Why this grant is in a migration rather than only in worker-role.sql ────
-- `infra/worker-role.sql` deliberately fixes the worker's table surface: new
-- tables do not auto-grant to it, and the file is extended and re-run by hand
-- so that widening the surface is an explicit decision. That posture is right,
-- and it is kept: this table is added there too, and that file remains the
-- readable source of truth for what the worker can touch.
--
-- It is repeated here because of what failure looks like otherwise. The ledger
-- insert shares sync's transaction, so a missing grant does not merely lose a
-- history row: it aborts the sync that was writing it. Relying on an operator
-- running a separate script at the right moment would make a routine deploy
-- able to break ingestion, and the ordering (release_command runs on the new
-- image before it takes traffic) is only guaranteed for migrations.
--
-- INSERT and SELECT only. The worker records history and never revises it,
-- which is the same rule the append-only trigger enforces for everyone else.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
    GRANT SELECT, INSERT ON "item_events" TO specboards_worker;

    -- The worker spans every workspace and runs with no `app.user_id`, so the
    -- member policy matches zero rows for it. A role-targeted policy is only
    -- evaluated when the connected role IS specboards_worker, so this grants
    -- cross-workspace access without loosening anything for specboards_app.
    DROP POLICY IF EXISTS item_events_worker_all ON "item_events";
    CREATE POLICY item_events_worker_all ON "item_events"
      FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
  END IF;
END $$;
