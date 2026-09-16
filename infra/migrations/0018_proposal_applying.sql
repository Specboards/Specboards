-- A proposal that is being applied says so, rather than saying it is applied.
--
-- `applyProposal` claims the proposal (`open` -> `applied`) and then writes to
-- the target. A process exit between the two leaves a row asserting that a
-- change happened when it never did. Found by the adversarial review of
-- v1.0.0..0c364b6 (AR-03, the crash-consistency half).
--
-- Claiming before writing is not the bug and stays: a conditional UPDATE is
-- the only atomic operation available, and it is what stops a double-click
-- writing twice. The bug is that `applied` was written before it was true.
--
-- `applying` is that claim, named honestly. A crash now leaves a row saying
-- "an application was started and nobody knows whether it finished", which is
-- a different claim from "this was applied" and one a reviewer can act on.
--
-- ── Why the resolution constraint needs no change ────────────────────────
-- `proposals_resolution_ck` requires a non-open row to carry `resolved_at`.
-- The claim sets `resolved_by` and `resolved_at` when it moves the row to
-- `applying`, because somebody really did decide to apply it at that moment;
-- what is not yet known is whether the write landed. So the existing rule
-- holds as written, and `applying` is a settled decision with an unsettled
-- outcome rather than a second kind of open.
--
-- ── No backfill ──────────────────────────────────────────────────────────
-- Nothing is in `applying` yet, by construction: the status did not exist
-- before this migration. Rows already stuck in the failure this fixes are
-- indistinguishable from honestly-applied ones, which is the defect, so there
-- is nothing this migration could correctly move.

ALTER TABLE proposals DROP CONSTRAINT proposals_status_ck;
--> statement-breakpoint

ALTER TABLE proposals ADD CONSTRAINT proposals_status_ck
    CHECK (status IN ('open', 'applying', 'applied', 'dismissed', 'superseded'));
--> statement-breakpoint

-- The review queue reads open proposals, and now also has to find the ones
-- left mid-apply so it can reconcile or surface them. Same shape as the
-- index the inbox query already uses.
CREATE INDEX IF NOT EXISTS proposals_applying_idx
    ON proposals (workspace_id, updated_at)
    WHERE status = 'applying';
