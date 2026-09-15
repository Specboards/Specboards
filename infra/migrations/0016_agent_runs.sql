-- "An agent is working on this item" becomes something you can look at.
--
-- Until now an agent connected over MCP was a sequence of tool calls and
-- nothing else. There was no object saying work was under way, no way to see
-- what it had done so far, no way to stop it, and no way for it to say it had
-- finished. A person whose item an agent was working on could only tell by
-- watching the item change.
--
-- A run is that object: one attempt by one agent at one target.
--
-- ── Why the status list is shorter than the card asked for ────────────────
-- The card (v1.3.0, "Agent runs") listed `proposed`, `applied` and `dismissed`
-- among the statuses. Those are the PROPOSAL's lifecycle, which became a real
-- one in migration 0015, and duplicating it here would mean two rows to keep
-- in step and a guaranteed drift the first time somebody applied a proposal
-- without the run hearing about it.
--
-- So a run's status is about the run: did it finish, fail, or get stopped.
-- What it produced is a `proposals` row pointing back at it, and "this run's
-- work landed" is a join, not a column somebody has to remember to update.
CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Routing snapshot for listing, with the same warning as `proposals`:
    -- the read policy below resolves the real target, because a wrong copy
    -- here must not be able to widen who can see a run.
    product_id uuid REFERENCES products(id) ON DELETE CASCADE,

    target_type text NOT NULL,
    target_id uuid NOT NULL,

    -- The agent doing the work: a service-account member's user id. Snapshot
    -- with no FK, the bargain `outbox_events` strikes, so retiring a service
    -- account does not erase the record of what it did.
    agent_id uuid,
    actor_type text NOT NULL,

    -- Why it started. The four trigger primitives the market converged on,
    -- plus `manual` for somebody pressing a button.
    trigger text NOT NULL,

    status text NOT NULL DEFAULT 'queued',

    -- One line the agent writes about what it is doing, for the item card.
    -- Its own words: a run that says "Reading 42 open ideas" is worth more to
    -- the person watching than a spinner, and we cannot generate it for them.
    summary text,

    -- Why it failed, when it did. Shown to a person, so an agent should write
    -- it for one.
    error text,

    -- A person's note to an agent mid-run, delivered on its next report.
    --
    -- One slot rather than a log: this is steering, not a conversation, and an
    -- agent that has not collected the last note does not need a queue of them
    -- building up behind it. Cleared when it is handed over.
    steer text,

    -- What the agent did, appended a step at a time. Capped in the service
    -- (`MAX_TRACE_STEPS`), because an agent in a loop would otherwise write
    -- until the row stopped fitting.
    trace jsonb NOT NULL DEFAULT '[]'::jsonb,

    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agent_runs_target_type_ck
        CHECK (target_type IN ('feature', 'release', 'doc_space')),
    CONSTRAINT agent_runs_actor_type_ck
        CHECK (actor_type IN ('user', 'agent', 'api_key', 'system')),
    CONSTRAINT agent_runs_trigger_ck
        CHECK (trigger IN ('assignment', 'mention', 'schedule', 'event', 'manual')),
    CONSTRAINT agent_runs_status_ck
        CHECK (status IN ('queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'cancelled')),

    -- A finished run carries a time, and an unfinished one does not. The
    -- terminal set is named here rather than left to the service, so a bug
    -- that forgets to stamp the clock fails loudly instead of leaving a run
    -- that reads as finished and sorts as though it never ended.
    CONSTRAINT agent_runs_finished_ck CHECK (
        (status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
    )
);
--> statement-breakpoint

-- Everything happening on one item, for the card's run strip.
CREATE INDEX agent_runs_target_idx
    ON agent_runs (target_type, target_id, created_at DESC);
--> statement-breakpoint

-- The workspace's runs, newest first, for an operations view.
CREATE INDEX agent_runs_ws_idx
    ON agent_runs (workspace_id, created_at DESC);
--> statement-breakpoint

-- Live runs, which is the question asked most often and by the most things:
-- the card badge, the cancel path, and the check that stops one agent opening
-- a second run on an item it is already working.
CREATE INDEX agent_runs_active_idx
    ON agent_runs (workspace_id, status)
    WHERE status IN ('queued', 'running', 'awaiting_input');
--> statement-breakpoint

COMMENT ON TABLE agent_runs IS
    'One attempt by one agent at one target. Status is about the run itself; what it produced is a proposals row pointing back at it.';
--> statement-breakpoint

COMMENT ON COLUMN agent_runs.product_id IS
    'Denormalised from the target for listing. Not the authorization: the read policy resolves the real target.';
--> statement-breakpoint

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The same shape as `proposals_read`, and for the same reason: the row's own
-- `product_id` is a copy, and `specboards_can_read_product` treats a null
-- product as workspace-wide, so trusting it would turn a data bug into a
-- disclosure. Resolve the real target and ask about its product.
CREATE POLICY agent_runs_read ON agent_runs FOR SELECT USING (
    (target_type = 'feature' AND EXISTS (
        SELECT 1 FROM features f
        WHERE f.id = agent_runs.target_id
          AND public.specboards_can_read_product(f.workspace_id, f.product_id)
    ))
    OR (target_type = 'release' AND EXISTS (
        SELECT 1 FROM releases r
        WHERE r.id = agent_runs.target_id
          AND public.specboards_can_read_product(r.workspace_id, r.product_id)
    ))
    OR (target_type = 'doc_space' AND EXISTS (
        SELECT 1 FROM doc_spaces d
        WHERE d.id = agent_runs.target_id
          AND public.specboards_can_read_product(d.workspace_id, d.product_id)
    ))
);
--> statement-breakpoint

-- Membership, matching `proposals_*`. Opening a run is not writing to the
-- target, and neither is cancelling one or leaving a steering note; whether
-- the agent may actually CHANGE anything is asked when it proposes, by the
-- proposal handler, against the target.
CREATE POLICY agent_runs_insert ON agent_runs FOR INSERT
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

CREATE POLICY agent_runs_update ON agent_runs FOR UPDATE
    USING (public.specboards_is_member(workspace_id))
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

CREATE POLICY agent_runs_delete ON agent_runs FOR DELETE
    USING (public.specboards_is_member(workspace_id));
--> statement-breakpoint

-- ── The foreign key migration 0015 could not add ──────────────────────────
--
-- `proposals.run_id` was left unconstrained because this table did not exist
-- yet. It does now.
--
-- CASCADE rather than SET NULL, which is forced: `proposals_origin_source_ck`
-- requires a run-origin proposal to HAVE a run, so nulling the column on
-- delete would leave a row the check refuses. RESTRICT would be the other
-- honest answer and was rejected because deleting a workspace cascades into
-- both tables and Postgres does not promise an order, so a restrict could
-- fail a delete that must succeed.
--
-- The consequence worth naming: deleting a run deletes the proposals it
-- produced, including applied ones. Nothing deletes runs today, and when
-- something does (retention, most likely) it needs to reckon with that rather
-- than discover it.
ALTER TABLE proposals
    ADD CONSTRAINT proposals_run_id_fk
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
--> statement-breakpoint

-- ── Cost, for native runs only ────────────────────────────────────────────
--
-- A run that goes through our model choke point already writes a
-- `model_usage_events` row per call; all it lacked was a way to say which run
-- it belonged to. With this the cost of a run is a sum over that table, which
-- means it is the same number the spend cap and the usage ledger use rather
-- than a second tally kept alongside them.
--
-- Nothing equivalent exists for a connected agent running on somebody else's
-- key, and the run row deliberately does NOT carry a reported token count for
-- one. We cannot verify a number an external agent tells us about its own
-- spend, and showing an unverifiable figure next to a real one, in the same
-- column, would make both of them untrustworthy.
ALTER TABLE model_usage_events
    ADD COLUMN run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX model_usage_events_run_idx
    ON model_usage_events (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint

-- ── The relay's reach ──────────────────────────────────────────────────────
--
-- Telling an item's watchers that an agent finished means reading the run that
-- finished. SELECT only, matching what migration 0015 granted for `proposals`
-- and for the same reason: the relay describes and never decides.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT ON agent_runs TO specboards_worker;

        DROP POLICY IF EXISTS agent_runs_worker_read ON agent_runs;
        CREATE POLICY agent_runs_worker_read ON agent_runs
            FOR SELECT TO specboards_worker USING (true);
    END IF;
END $$;
