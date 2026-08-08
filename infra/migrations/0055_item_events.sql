-- The item change ledger: who changed what, when, and what it was before.
--
-- A customer asked for a change log and the ability to revert changes, and we
-- want reporting on who changed what over time. None of that is possible today:
-- change a status or an assignee and the previous value is simply gone.
--
-- ── Why a new table rather than reusing outbox_events ──────────────────────
-- `outbox_events` already appends inside the same transaction as the change
-- that produced it, which is the genuinely hard part and the pattern this
-- follows. But it is a delivery queue: it carries `processed_at`, its payload
-- is shaped for webhook consumers, and rows are prunable once delivered. A
-- ledger is immutable and must never be pruned on a delivery schedule. One
-- table cannot hold both lifetimes without a retention rule written for the
-- queue quietly deleting the audit trail.
--
-- ── Why the item identity is snapshotted and has no foreign key ────────────
-- `feature_id` deliberately carries no FK. An audit trail that erases itself
-- when the item is deleted is not an audit trail, and "who deleted this and
-- what was it" is exactly the question people ask. `spec_id` and `item_title`
-- are snapshots for the same reason: they keep a deleted item's history
-- readable. Workspace deletion still cascades, because that is tenant removal
-- rather than an edit.
--
-- ── Why the actor is a type, an id and a label ─────────────────────────────
-- In this product a change is made by a person, an API key, an MCP agent, or
-- the sync engine reconciling someone's git commit. "Who changed what" is close
-- to useless if automated writes are indistinguishable from human ones, and
-- that distinction cannot be added retroactively to rows already written. The
-- label is snapshotted because users get renamed and deleted.
--
-- ── What is deliberately NOT stored here ───────────────────────────────────
-- Spec body content. Git is canonical for a spec and `spec_index` is a cache;
-- keeping our own copy of past spec text would create a second source of truth
-- for the one thing the product insists git owns, and the two would diverge.
-- Spec-content events record `commit_sha` and point at git for the text.

CREATE TABLE "item_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,

  -- Item identity, snapshotted (see above). No FK by design.
  "feature_id" uuid,
  "spec_id" uuid,
  "item_title" text,
  -- Routing/reporting scope at the time of the change; null = no product.
  "product_id" uuid,

  -- Who. `actor_id` is the user the action ran as, including the owner of the
  -- API key an agent authenticated with, so attribution survives even when the
  -- caller was an automation.
  "actor_type" text NOT NULL,
  "actor_id" uuid,
  "actor_label" text,

  -- What. `type` names the event; `field` plus `before`/`after` describe a
  -- field change specifically, which is what makes revert and reporting
  -- possible. "status changed" cannot be reverted; "ready to in_progress" can.
  "type" text NOT NULL,
  "field" text,
  "before" jsonb,
  "after" jsonb,
  -- Room for event-specific detail that is not a field change.
  "data" jsonb,
  -- For spec-content events: the commit the change landed in. Lifted out of
  -- `data` so reporting can reach git without digging through jsonb.
  "commit_sha" text,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Keep the actor vocabulary closed rather than trusting every future write path
-- to spell it consistently. Reporting groups on this column, and a stray
-- 'API_KEY' would silently split a bucket in two.
ALTER TABLE "item_events" ADD CONSTRAINT "item_events_actor_type_check"
  CHECK ("actor_type" IN ('user', 'api_key', 'agent', 'sync', 'system'));--> statement-breakpoint

-- One item's history, newest first: the change log panel's query.
CREATE INDEX "item_events_item_idx"
  ON "item_events" ("workspace_id", "feature_id", "created_at" DESC);--> statement-breakpoint
-- The workspace-wide feed, and the spine of cross-item reporting.
CREATE INDEX "item_events_ws_created_idx"
  ON "item_events" ("workspace_id", "created_at" DESC);--> statement-breakpoint
-- "What has this person changed": the reporting question that names an actor.
CREATE INDEX "item_events_actor_idx"
  ON "item_events" ("workspace_id", "actor_id", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "item_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY item_events_member_all ON "item_events"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint

-- Append-only, enforced in the database. A revert is a new forward event, never
-- an edit of the record it undoes: history that can be rewritten is worthless
-- to anyone who wants this for compliance, and a code-level convention is one
-- careless UPDATE away from being untrue. DELETE is left alone so workspace
-- cascade still removes a departing tenant's data.
CREATE OR REPLACE FUNCTION specboards_item_events_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'item_events is append-only; record a new event instead of updating %', OLD.id;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER item_events_no_update
  BEFORE UPDATE ON "item_events"
  FOR EACH ROW EXECUTE FUNCTION specboards_item_events_immutable();--> statement-breakpoint

-- The app connects as a non-owner role with RLS enforced (see
-- infra/rls-role.sql); tables created after that cutover need their grants.
-- No UPDATE: the trigger would reject it anyway, and withholding the grant says
-- so at the permission layer too.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, DELETE ON "item_events" TO specboards_app;
  END IF;
END $$;
