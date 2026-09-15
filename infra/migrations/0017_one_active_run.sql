-- One agent, one item, one run at a time. Enforced rather than asserted.
--
-- Migration 0016 created `agent_runs_active_idx` and its comment called it
-- "the check that stops one agent opening a second run on an item it is
-- already working". It is a plain partial index. It stops nothing, and the
-- service's own `findActiveRun`-then-`createRun` is a read followed by an
-- unconditional write, so two concurrent opens produce two active runs.
--
-- Found by the adversarial review of v1.0.0..0c364b6 (AR-02). The index the
-- comment described is the fix, so this creates it.
--
-- ── Why `agent_id` may repeat when it is NULL ─────────────────────────────
-- Postgres treats NULLs as distinct in a unique index, so several active runs
-- with no agent can coexist. That is the right outcome: a run with no agent
-- is a person driving `report_run` by hand, and there is no identity to
-- collide on.

-- Existing duplicates first, or the index cannot be built. Keeps the newest
-- active run per (workspace, agent, target) and stops the rest, which is the
-- same outcome the application would have produced had the constraint existed:
-- the later open wins and the abandoned one is not left looking live forever.
UPDATE agent_runs a
SET status = 'cancelled',
    finished_at = now(),
    updated_at = now()
WHERE a.status IN ('queued', 'running', 'awaiting_input')
  AND a.agent_id IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM agent_runs b
      WHERE b.workspace_id = a.workspace_id
        AND b.agent_id = a.agent_id
        AND b.target_type = a.target_type
        AND b.target_id = a.target_id
        AND b.status IN ('queued', 'running', 'awaiting_input')
        AND (b.created_at, b.id) > (a.created_at, a.id)
  );
--> statement-breakpoint

CREATE UNIQUE INDEX agent_runs_one_active_uq
    ON agent_runs (workspace_id, agent_id, target_type, target_id)
    WHERE status IN ('queued', 'running', 'awaiting_input');
--> statement-breakpoint

COMMENT ON INDEX agent_runs_one_active_uq IS
    'One active run per agent per target. What migration 0016 described and did not enforce.';
