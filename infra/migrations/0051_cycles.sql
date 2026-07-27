-- Cycles (sprints / iterations): a date-bounded time box a team works in.
--
-- Deliberately a SECOND, ORTHOGONAL AXIS to releases rather than a flavour of
-- one. A release answers "what ships together" and is customer-facing, with an
-- explicit planned/in_progress/shipped lifecycle. A cycle answers "what is the
-- team working on for the next two weeks" and is team-facing. An item can be in
-- release v1.0 AND in cycle "Sprint 14"; clearing one leaves the other alone.
--
-- There is no status column, on purpose. A cycle is upcoming, active, or
-- complete purely as a function of today against start_date/end_date, so it can
-- never go stale and needs no cron. This is what releases.shipped_date could
-- not do (it needed migration 0043 to fix the reopen/re-stamp problem).
--
-- The shape mirrors releases so the existing patterns transfer: nullable
-- product_id (null = workspace-wide, spanning every product), names unique per
-- product and independently within the workspace-wide scope, and
-- features.cycle_id ON DELETE SET NULL so deleting a cycle unschedules its
-- items and destroys no work.

CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Dates are date-only strings; the ordering invariant is enforced here so no
-- API path can persist a cycle that ends before it starts.
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_dates_check" CHECK ("end_date" >= "start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_product_name_uq" ON "cycles" USING btree ("product_id","name") WHERE "cycles"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_ws_global_name_uq" ON "cycles" USING btree ("workspace_id","name") WHERE "cycles"."product_id" is null;--> statement-breakpoint
CREATE INDEX "cycles_ws_idx" ON "cycles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cycles_product_idx" ON "cycles" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "cycles_dates_idx" ON "cycles" USING btree ("workspace_id","start_date","end_date");--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "features_cycle_idx" ON "features" USING btree ("cycle_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS: modelled directly on the releases policy (0021). Cycle metadata is
-- visible and writable to members of the workspace; the per-product write rule
-- (product admins/contributors for a product cycle, owner only for a
-- workspace-wide one) is enforced in the service layer exactly as it is for
-- releases, because it depends on product_members grants the policy would have
-- to re-derive.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "cycles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cycles_member_all ON "cycles"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint

-- The app connects as a non-owner role with RLS enforced (see
-- infra/app-role.sql); a table created after that cutover needs its grants.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "cycles" TO specboards_app;
  END IF;
END $$;
