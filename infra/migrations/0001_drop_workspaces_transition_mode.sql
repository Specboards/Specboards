-- Phase two of the two-phase column removal left open by the original 0064
-- (PR #258), which moved the transition mode to `product_settings` and then
-- stopped reading `workspaces.transition_mode` without dropping it.
--
-- The column stayed because migrations run in Fly's `release_command`, before
-- the new image takes traffic. Dropping a column the currently-serving version
-- still reads would have broken every Cards page and `/api/v1/statuses` call
-- for the length of the release, and again on any rollback. The per-product
-- code has been on production since then, so the shim has done its job.
--
-- Dropping the column removes the ability to roll back to an image that reads
-- it. That is the intended end state.

-- Keep the mode of any workspace the original backfill never reached.
--
-- 0064 copied every workspace that existed at the time. This covers the two
-- ways a workspace can still be missing its default row: one created between
-- that migration and the per-product code deploying, and one on a self-hosted
-- instance whose history we cannot inspect. Without this, such a workspace
-- would lose a `strict` setting and silently fall back to the built-in
-- `flexible` the moment the column went away.
--
-- Nothing is written for a workspace that already has a default row, so this is
-- a no-op on every database that ran 0064 and has not since created one.
--
-- Note that this statement reads a column the last one drops, so the file as a
-- whole cannot be replayed against a database it has already run on. It does
-- not need to be: drizzle applies each file once, inside a transaction, so a
-- failure part way through rolls back the drop along with everything else and
-- the retry starts again with the column still there.
INSERT INTO product_settings (workspace_id, product_id, transition_mode)
SELECT w.id, NULL, w.transition_mode
FROM workspaces w
WHERE NOT EXISTS (
    SELECT 1
    FROM product_settings ps
    WHERE ps.workspace_id = w.id
      AND ps.product_id IS NULL
);
--> statement-breakpoint

-- `setTransitionMode` was the only tenant-path write to `workspaces`, and it
-- writes `product_settings` now, so nothing needs UPDATE on this table any
-- more. The policy was added by 0062 to fix #256 and became vestigial the
-- moment the setting moved. Leaving it grants org admins a write privilege with
-- no app path behind it, which is worth removing on its own terms.
DROP POLICY IF EXISTS workspaces_admin_update ON workspaces;
--> statement-breakpoint

-- Takes `workspaces_transition_mode_check` with it.
ALTER TABLE workspaces DROP COLUMN IF EXISTS transition_mode;
