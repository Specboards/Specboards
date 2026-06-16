CREATE TYPE "public"."feature_link_type" AS ENUM('blocks', 'relates_to', 'duplicates');--> statement-breakpoint
CREATE TABLE "feature_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_feature_id" uuid NOT NULL,
	"to_feature_id" uuid NOT NULL,
	"type" "feature_link_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_links_uq" UNIQUE("from_feature_id","to_feature_id","type")
);
--> statement-breakpoint
ALTER TABLE "feature_links" ADD CONSTRAINT "feature_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_links" ADD CONSTRAINT "feature_links_from_feature_id_features_id_fk" FOREIGN KEY ("from_feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_links" ADD CONSTRAINT "feature_links_to_feature_id_features_id_fk" FOREIGN KEY ("to_feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_links_from_idx" ON "feature_links" USING btree ("from_feature_id");--> statement-breakpoint
CREATE INDEX "feature_links_to_idx" ON "feature_links" USING btree ("to_feature_id");--> statement-breakpoint
-- RLS: a link is visible/editable only to members of its workspace
-- (mirrors the per-table policies in 0002_rls_policies.sql).
ALTER TABLE "feature_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY feature_links_member_all ON "feature_links"
  FOR ALL USING (specboard_is_member(workspace_id))
  WITH CHECK (specboard_is_member(workspace_id));