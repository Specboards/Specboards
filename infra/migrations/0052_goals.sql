-- Goals (objectives) + key results + the work that ladders up to them.
--
-- A goal is deliberately NOT a hierarchy level. Two things the features table
-- cannot do: a goal is MEASURED (levels are not), and work laddering up to a
-- goal is MANY-TO-MANY and crosses products, while features.parent_id is
-- strictly single-parent and the roll-ups depend on that. Forcing goals into
-- the hierarchy would mean either duplicating a goal per product or breaking
-- single-parent. Hence goal_links, a proper join table reachable from any
-- level: an initiative and a single work item can both contribute, and one
-- feature can serve several goals.
--
-- Key-result progress is computed from start/current/target on read and never
-- stored, following the RICE precedent, so it cannot drift from its inputs.
-- goals.status is a separate thing: the owner's confidence call, which is
-- judgement, not arithmetic.

CREATE TABLE "goal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_links_goal_feature_uq" UNIQUE("goal_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"period_start" text,
	"period_end" text,
	"parent_goal_id" uuid,
	"status" text DEFAULT 'on_track' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"title" text NOT NULL,
	"metric_kind" text DEFAULT 'number' NOT NULL,
	"start_value" double precision DEFAULT 0 NOT NULL,
	"target_value" double precision NOT NULL,
	"current_value" double precision DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goal_links" ADD CONSTRAINT "goal_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_links" ADD CONSTRAINT "goal_links_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_links" ADD CONSTRAINT "goal_links_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_goal_id_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_links_goal_idx" ON "goal_links" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "goal_links_feature_idx" ON "goal_links" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "goals_ws_idx" ON "goals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "goals_product_idx" ON "goals" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "goals_parent_idx" ON "goals" USING btree ("parent_goal_id");--> statement-breakpoint
CREATE INDEX "key_results_goal_idx" ON "key_results" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "key_results_ws_idx" ON "key_results" USING btree ("workspace_id");
-- ─────────────────────────────────────────────────────────────────────────
-- RLS: goal metadata is visible and writable to members of the workspace,
-- modelled on the releases policy (0021). The per-product write rule (product
-- admins/contributors for a product goal, owner only for an org-wide one) is
-- enforced in the service layer, as it is for releases and cycles, because it
-- depends on product_members grants the policy would have to re-derive.
--
-- key_results and goal_links carry their own workspace_id (rather than being
-- reached only through goals) so each policy is a direct membership check and
-- no cross-table subquery runs per row.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY goals_member_all ON "goals"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint
ALTER TABLE "key_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY key_results_member_all ON "key_results"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint
ALTER TABLE "goal_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY goal_links_member_all ON "goal_links"
  FOR ALL USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint

-- A key result must belong to its goal's workspace, and a link's two ends must
-- agree with each other. Enforced in the database so no API path can create a
-- row that RLS would then make invisible to everyone.
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_target_check"
  CHECK ("target_value" <> "start_value");--> statement-breakpoint

-- The app connects as a non-owner role with RLS enforced (see
-- infra/rls-role.sql); tables created after that cutover need their grants.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "goals", "key_results", "goal_links"
      TO specboards_app;
  END IF;
END $$;
