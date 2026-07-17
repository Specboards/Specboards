CREATE TABLE "product_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_repositories_repo_product_uq" UNIQUE("repo_id","product_id")
);
--> statement-breakpoint
-- Moved ahead of the composite FK below that references it (drizzle-kit
-- emitted it last, which fails at apply time).
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_id_ws_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "product_repositories" ADD CONSTRAINT "product_repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_repositories" ADD CONSTRAINT "product_repositories_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_repositories" ADD CONSTRAINT "product_repositories_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_repositories" ADD CONSTRAINT "product_repositories_repo_ws_fk" FOREIGN KEY ("repo_id","workspace_id") REFERENCES "public"."repositories"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_repositories" ADD CONSTRAINT "product_repositories_product_ws_fk" FOREIGN KEY ("product_id","workspace_id") REFERENCES "public"."products"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_repositories_repo_idx" ON "product_repositories" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "product_repositories_product_idx" ON "product_repositories" USING btree ("product_id");--> statement-breakpoint
-- At most one default product per repo (hand-written: Drizzle can't express
-- partial unique indexes). The default is one of the linked products by
-- construction since it lives on the link row itself.
CREATE UNIQUE INDEX "product_repositories_repo_default_uq"
  ON "product_repositories" ("repo_id") WHERE "is_default";--> statement-breakpoint
-- Members can read links (they see repos and products already); managing them
-- is org-admin only, matching repo connection in /api/v1/repositories.
ALTER TABLE "product_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_repositories_member_select ON "product_repositories"
  FOR SELECT USING (specboard_is_member(workspace_id));--> statement-breakpoint
CREATE POLICY product_repositories_admin_insert ON "product_repositories"
  FOR INSERT WITH CHECK (specboard_is_org_admin(workspace_id));--> statement-breakpoint
CREATE POLICY product_repositories_admin_update ON "product_repositories"
  FOR UPDATE USING (specboard_is_org_admin(workspace_id))
  WITH CHECK (specboard_is_org_admin(workspace_id));--> statement-breakpoint
CREATE POLICY product_repositories_admin_delete ON "product_repositories"
  FOR DELETE USING (specboard_is_org_admin(workspace_id));--> statement-breakpoint
-- Backfill: pin every existing repo's default to its workspace's default
-- product (the product all synced specs landed in before this migration), so
-- sync behavior is unchanged for existing installs.
INSERT INTO product_repositories (workspace_id, repo_id, product_id, is_default)
SELECT r.workspace_id, r.id, p.id, true
FROM repositories r
JOIN products p ON p.workspace_id = r.workspace_id AND p.key = 'default'
ON CONFLICT (repo_id, product_id) DO NOTHING;
