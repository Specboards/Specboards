-- Workflow transition mode: make strict-vs-flexible stage movement an explicit
-- workspace setting instead of an accident of configuration.
--
-- Until now the choice was implied. A workspace with no rows in
-- workspace_statuses fell back to the built-in workflow, whose transitions are
-- single-step (backlog -> defining -> ready -> ...). The moment an admin saved
-- anything in Settings > Cards > Workflow, resolveWorkflowFor switched to
-- workflowFromStages, whose transitions were fully open. Two workspaces with
-- identical stage names therefore behaved differently depending on how those
-- stages came to exist, and nobody had chosen either behavior.
--
-- New workspaces default to 'flexible'. Existing ones are backfilled to
-- whatever they already do, so this migration changes no workspace's behavior:
--   >= 2 own stages  -> 'flexible' (what workflowFromStages already gave them)
--   otherwise        -> 'strict'   (the built-in single-step workflow)
--
-- A repo config that pins `transitions` in .specboards/config.yml still wins
-- over the setting, so config-driven state machines are unaffected either way.

ALTER TABLE "workspaces" ADD COLUMN "transition_mode" text DEFAULT 'flexible' NOT NULL;--> statement-breakpoint

UPDATE "workspaces" w SET "transition_mode" = CASE
  WHEN (
    SELECT count(*) FROM "workspace_statuses" s WHERE s."workspace_id" = w."id"
  ) >= 2 THEN 'flexible'
  ELSE 'strict'
END;--> statement-breakpoint

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_transition_mode_check"
  CHECK ("transition_mode" IN ('strict', 'flexible'));
