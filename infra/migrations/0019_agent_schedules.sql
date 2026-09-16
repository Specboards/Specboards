-- Schedules: running a skill on a recurring basis, with nobody watching.
--
-- The harness has been reactive-only. Work reaches an agent because somebody
-- assigned it, mentioned it, or pressed a button, which means the value only
-- arrives when a person remembers to ask for it. A schedule is the proactive
-- trigger, and it is where recurring agent value compounds for a product team:
-- the weekly review that happens whether or not anybody remembered.
--
-- ── Why a table and an in-process dispatcher, not a queue ──────────────────
-- The same answer `webhook_deliveries` gave. One machine, a claim with
-- FOR UPDATE SKIP LOCKED so a second one would still be correct, and a lease
-- so a crashed firing becomes due again rather than being lost. An external
-- queue would be a second piece of infrastructure for a self-hoster to run,
-- and this feature does not need one.
--
-- ── Why the wall clock and a zone, not a UTC instant ──────────────────────
-- A weekly digest set for Monday 09:00 has to arrive at 09:00 local in March
-- and in July. Storing the instant and adding seven days drifts by an hour
-- twice a year, which nobody reports and everybody notices. `cadence` holds
-- the sentence ("every Monday at 09:00"), `time_zone` holds the zone it means,
-- and `next_run_at` is the resolved instant, recomputed after each firing by
-- `lib/schedules/cadence.ts`.
--
-- ── Why failures are counted rather than only logged ──────────────────────
-- The market lesson this card carries is ChatGPT's scheduled tasks, which died
-- silently when the surface they were coupled to went away. A schedule that
-- stops working must say so. `consecutive_failures` is what lets the dispatcher
-- tell a blip from a schedule that is never going to work again, and notify
-- rather than retry forever.

CREATE TABLE agent_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Routing snapshot for listing and filtering, exactly as `agent_runs` and
    -- `proposals` carry one. NOT the authorization: the read policy below
    -- resolves the real target, because a stale copy here would turn a data
    -- bug into a disclosure.
    product_id uuid REFERENCES products(id) ON DELETE SET NULL,

    -- What the person called it, so a list of schedules reads as their words
    -- rather than as a skill key repeated four times.
    name text NOT NULL,

    -- The skill to run. A key rather than a foreign key, because built-in
    -- skills live in code and have no row to point at; `findEnabledSkill`
    -- resolves it the same way every other caller does. A schedule naming a
    -- skill that has been deleted or switched off fails loudly at firing time,
    -- which is the behaviour this table's failure counter exists for.
    skill_key text NOT NULL,

    -- Only `feature` today. A schedule over a product's ideas is the case this
    -- feature was really written for, and it is blocked on a skill surface that
    -- does not exist yet, so the constraint is written narrow and widened by
    -- the card that adds the surface rather than left permissive in advance.
    target_type text NOT NULL,
    target_id uuid NOT NULL,

    -- `{ every: 'day'|'week'|'month', hour, minute, weekday?, day? }`. Shape is
    -- enforced by `parseCadence` on the way in rather than by a CHECK, because
    -- the rule is "these fields for this variant" and a CHECK expressing that
    -- over jsonb would be unreadable and still wrong at the edges.
    cadence jsonb NOT NULL,
    time_zone text NOT NULL,

    enabled boolean NOT NULL DEFAULT true,

    -- The instant the dispatcher claims on. Also the lease: claiming pushes it
    -- forward, so a firing that crashes mid-flight becomes due again rather
    -- than being lost, and two dispatchers cannot both take the same row.
    next_run_at timestamptz NOT NULL,

    last_run_at timestamptz,
    -- The run the last firing produced. No foreign key on purpose: runs are
    -- subject to retention and a schedule outliving its oldest run should keep
    -- working rather than lose the column to a cascade.
    last_run_id uuid,
    last_error text,
    consecutive_failures integer NOT NULL DEFAULT 0,

    -- Whose access and whose budget a firing uses. A scheduled run acts as the
    -- person who set it up, which is the only attribution that is true: it can
    -- reach exactly what they can reach, and the usage ledger names them.
    --
    -- No foreign key to `users`, matching `proposals.actor_id` and
    -- `outbox_events.actor_id`. A deleted user must not cascade away the
    -- schedule silently; the firing fails loudly instead, and the failure says
    -- who is missing.
    created_by uuid NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT agent_schedules_target_type_ck
        CHECK (target_type IN ('feature')),
    CONSTRAINT agent_schedules_failures_ck
        CHECK (consecutive_failures >= 0),
    CONSTRAINT agent_schedules_name_ck
        CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT agent_schedules_zone_ck
        CHECK (length(btrim(time_zone)) BETWEEN 1 AND 64)
);
--> statement-breakpoint

-- The dispatcher's only query: what is due. Partial on `enabled` because a
-- disabled schedule is never due, and a workspace that has switched several
-- off should not make the sweep read them every thirty seconds.
CREATE INDEX agent_schedules_due_idx
    ON agent_schedules (next_run_at)
    WHERE enabled;
--> statement-breakpoint

CREATE INDEX agent_schedules_ws_idx
    ON agent_schedules (workspace_id, created_at);
--> statement-breakpoint

-- Finding the schedules pointed at something, which is what the settings page
-- shows on an item and what a deletion has to clean up.
CREATE INDEX agent_schedules_target_idx
    ON agent_schedules (target_type, target_id);
--> statement-breakpoint

COMMENT ON COLUMN agent_schedules.product_id IS
    'Denormalised from the target for listing. Not the authorization: the read policy resolves the real target.';
--> statement-breakpoint

COMMENT ON COLUMN agent_schedules.next_run_at IS
    'When this fires next, and the claim lease. Recomputed from cadence + time_zone after every firing.';
--> statement-breakpoint

ALTER TABLE agent_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The same shape as `agent_runs_read` and `proposals_read`, and for the same
-- reason: `product_id` on this row is a copy, and `specboards_can_read_product`
-- treats a null product as workspace-wide, so trusting the copy would turn a
-- data bug into a disclosure. Resolve the real target and ask about its
-- product.
CREATE POLICY agent_schedules_read ON agent_schedules FOR SELECT USING (
    target_type = 'feature' AND EXISTS (
        SELECT 1 FROM features f
        WHERE f.id = agent_schedules.target_id
          AND public.specboards_can_read_product(f.workspace_id, f.product_id)
    )
);
--> statement-breakpoint

-- Writing is owner-only, unlike `agent_runs`, and the difference is deliberate.
-- Opening a run records that work is happening. Creating a schedule commits the
-- workspace to spending its inference budget every week from now on, without
-- anybody present at the moment it spends. That is an administrative decision,
-- and it matches the gate on the skills the schedule runs.
CREATE POLICY agent_schedules_insert ON agent_schedules FOR INSERT
    WITH CHECK (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint

CREATE POLICY agent_schedules_update ON agent_schedules FOR UPDATE
    USING (public.specboards_is_org_admin(workspace_id))
    WITH CHECK (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint

CREATE POLICY agent_schedules_delete ON agent_schedules FOR DELETE
    USING (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint

-- ── The dispatcher's reach ────────────────────────────────────────────────
--
-- Wider than the relay's, and this is the one grant in the feature worth
-- reading twice. The relay only ever describes what already happened, so it
-- was granted SELECT. The dispatcher decides that a firing is due and records
-- what came of it, so it needs UPDATE as well.
--
-- What it still cannot do is act. Claiming a schedule tells the dispatcher to
-- start a run, and the run itself is opened on the ordinary application
-- connection as the schedule's owner, under their row-level security. So the
-- worker role can move a schedule's clock forward and can write down that a
-- firing failed, and it cannot read or change anything the schedule points at.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT, UPDATE ON agent_schedules TO specboards_worker;

        DROP POLICY IF EXISTS agent_schedules_worker_all ON agent_schedules;
        CREATE POLICY agent_schedules_worker_all ON agent_schedules
            FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
    END IF;
END $$;
