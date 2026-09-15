-- A proposal becomes a thing, instead of five columns on a chat message.
--
-- Until now "the assistant has suggested an edit" was recorded as
-- `proposal_outcome`, `proposal_resolved_by`, `proposal_resolved_at`,
-- `proposal_commit_sha` and `proposal_base_sha` on `assistant_messages`, and
-- whether a message *contained* a proposal was not recorded at all: it was
-- re-derived by parsing the body for a marker block. That worked because there
-- was exactly one kind of proposal, it belonged to exactly one conversation,
-- and a person was sitting in front of it when it was made.
--
-- The agent harness breaks all three assumptions. An agent working an item
-- unattended produces deliverables of several shapes, against targets that are
-- not always items, that nobody is watching arrive. Those need somewhere to
-- wait, a lifecycle, and a queue to wait in.
--
-- ── What this does NOT change ──────────────────────────────────────────────
-- The invariant in `lib/assistant-proposals.ts`: nothing a model produces
-- reaches the repo without a human accepting it, and once accepted it travels
-- the same write path as a human edit. This table is where a proposal waits.
-- It is not a way to apply one.
CREATE TABLE proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Routing snapshot, so the inbox can filter to the products a viewer can
    -- see without resolving the target of every row first. Read the warning on
    -- `proposals_read` below: this column is a filter, NOT the authorization.
    product_id uuid REFERENCES products(id) ON DELETE CASCADE,

    -- Where the proposal was made, which decides which surface renders it.
    -- `conversation` stays in the thread that produced it, exactly as today.
    -- `run` goes to the review inbox, because nobody was watching.
    origin text NOT NULL,
    source_message_id uuid REFERENCES assistant_messages(id) ON DELETE CASCADE,

    -- The agent run that produced it. No foreign key yet: `agent_runs` lands
    -- with the next card in this release and its migration adds the constraint.
    -- Nothing writes a run-origin proposal until that table exists.
    run_id uuid,

    -- Who drafted it. Snapshot with no FK, the same bargain `outbox_events`
    -- strikes: deleting a service account must not rewrite the record of what
    -- it proposed.
    actor_id uuid,
    actor_type text NOT NULL,

    kind text NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,

    -- The proposed change, shaped per kind and parsed by that kind's handler.
    payload jsonb NOT NULL,

    -- What the draft was written against: a blob sha for a git-backed spec, a
    -- content version for a card or release. Null means the row predates the
    -- guard, which is allowed through rather than refused, matching the
    -- existing `assertNotStale`.
    base_version text,

    -- Where the claims came from, so a reader can check them. See the cap in
    -- `lib/proposals/types.ts` and the reasoning on MAX_PROPOSED_CHILDREN.
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,

    status text NOT NULL DEFAULT 'open',
    resolved_by uuid,
    resolved_at timestamptz,

    -- What applying it produced: commit sha, pull request, created item ids.
    -- Written after the write succeeds, never guessed before it, for the reason
    -- `settled()` gives about a sha no commit matches.
    result jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT proposals_origin_ck
        CHECK (origin IN ('conversation', 'run')),
    CONSTRAINT proposals_actor_type_ck
        CHECK (actor_type IN ('user', 'agent', 'api_key', 'system')),
    CONSTRAINT proposals_kind_ck
        CHECK (kind IN ('spec_content', 'item_metadata', 'item_batch', 'doc_draft')),
    CONSTRAINT proposals_target_type_ck
        CHECK (target_type IN ('feature', 'release', 'doc_space')),
    CONSTRAINT proposals_status_ck
        CHECK (status IN ('open', 'applied', 'dismissed', 'superseded')),

    -- Exactly one source, matching `origin`. A row with both would render in
    -- two places and be claimable from each.
    CONSTRAINT proposals_origin_source_ck CHECK (
        (origin = 'conversation' AND source_message_id IS NOT NULL AND run_id IS NULL)
        OR (origin = 'run' AND run_id IS NOT NULL AND source_message_id IS NULL)
    ),

    -- An open proposal carries no resolution, and a settled one carries a time.
    -- `resolved_by` stays nullable because `superseded` is written by the
    -- system, and naming a person who did not decide would be a lie in the
    -- one column somebody would later trust.
    CONSTRAINT proposals_resolution_ck CHECK (
        (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
        OR (status <> 'open' AND resolved_at IS NOT NULL)
    )
);
--> statement-breakpoint

-- The inbox query: open rows for a workspace, newest first.
CREATE INDEX proposals_inbox_idx
    ON proposals (workspace_id, status, created_at DESC);
--> statement-breakpoint

-- Everything proposed against one item, for the card's review strip.
CREATE INDEX proposals_target_idx
    ON proposals (target_type, target_id);
--> statement-breakpoint

-- One run's deliverables. Partial: most rows are conversation-origin and
-- indexing their null run_id buys nothing.
CREATE INDEX proposals_run_idx
    ON proposals (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint

-- How the conversation panel finds the proposal for a turn it is rendering.
-- This is the hot path for the surface that exists today, so it is partial for
-- the same reason and pointed the other way.
CREATE INDEX proposals_source_message_idx
    ON proposals (source_message_id) WHERE source_message_id IS NOT NULL;
--> statement-breakpoint

COMMENT ON TABLE proposals IS
    'A change an agent or the assistant has suggested and a human has not yet applied. One row per proposal, whatever its shape or target. Applying one goes down the ordinary human write path; this table never writes to a target itself.';
--> statement-breakpoint

COMMENT ON COLUMN proposals.product_id IS
    'Denormalised from the target for inbox filtering. Not the authorization: the read policy resolves the real target.';
--> statement-breakpoint

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── Why this resolves the target instead of trusting product_id ────────────
--
-- `product_id` on this row is a copy, written by whatever created the proposal.
-- If it is ever wrong, or null when it should not be, `specboards_can_read_product`
-- returns true for every member (a null product means workspace-wide), and a
-- proposal about a private product becomes visible to the whole workspace.
--
-- That is a data bug turning into a disclosure, which is the category of
-- mistake row-level security exists to make impossible rather than unlikely.
-- So the policy joins the actual target and asks about ITS product, the same
-- shape `assistant_messages_read` already uses. The denormalised column stays
-- for the index, and carries a COMMENT saying it is not to be trusted for this.
CREATE POLICY proposals_read ON proposals FOR SELECT USING (
    (target_type = 'feature' AND EXISTS (
        SELECT 1 FROM features f
        WHERE f.id = proposals.target_id
          AND public.specboards_can_read_product(f.workspace_id, f.product_id)
    ))
    OR (target_type = 'release' AND EXISTS (
        SELECT 1 FROM releases r
        WHERE r.id = proposals.target_id
          AND public.specboards_can_read_product(r.workspace_id, r.product_id)
    ))
    OR (target_type = 'doc_space' AND EXISTS (
        SELECT 1 FROM doc_spaces d
        WHERE d.id = proposals.target_id
          AND public.specboards_can_read_product(d.workspace_id, d.product_id)
    ))
);
--> statement-breakpoint

-- Insert, update and delete are workspace membership, deliberately matching
-- `assistant_messages_*` rather than the stricter `features_*`.
--
-- Proposing is not writing. The question "may this caller change the target"
-- is asked by the handler's `load`, against the target, using the same
-- `canEditItem` / `canEditRelease` checks a human edit goes through, and it is
-- asked again by the write path the handler calls. Putting a product-write
-- check here as well would mean a contributor could not so much as dismiss a
-- proposal on an item they can read, which is not the rule anybody wants.
CREATE POLICY proposals_insert ON proposals FOR INSERT
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

CREATE POLICY proposals_update ON proposals FOR UPDATE
    USING (public.specboards_is_member(workspace_id))
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

CREATE POLICY proposals_delete ON proposals FOR DELETE
    USING (public.specboards_is_member(workspace_id));
--> statement-breakpoint

-- ── The relay's reach ──────────────────────────────────────────────────────
--
-- `proposal.opened` notifies an item's watchers that an agent has left
-- something for them, and the notification relay runs as `specboards_worker`
-- with no `app.user_id`, so it needs a role-targeted policy and an explicit
-- grant like every other table on its surface.
--
-- SELECT only. The relay reads a proposal to describe it in a notice and never
-- decides anything about one, which is the same bargain migrations 0002, 0003,
-- 0007 and 0014 struck for the tables already on that surface.
--
-- Granted here as well as in infra/worker-role.sql for the reason those
-- migrations give: that file is run by hand once per database, and this makes
-- an already-provisioned database correct the moment the migration lands.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT ON proposals TO specboards_worker;

        DROP POLICY IF EXISTS proposals_worker_read ON proposals;
        CREATE POLICY proposals_worker_read ON proposals
            FOR SELECT TO specboards_worker USING (true);
    END IF;
END $$;
