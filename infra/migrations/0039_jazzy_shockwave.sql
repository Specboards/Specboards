CREATE TABLE "product_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_groups_ws_key_uq" UNIQUE("workspace_id","key"),
	CONSTRAINT "product_groups_id_ws_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_parent_id_product_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_parent_ws_fk" FOREIGN KEY ("parent_id","workspace_id") REFERENCES "public"."product_groups"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_groups_ws_idx" ON "product_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "product_groups_parent_idx" ON "product_groups" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_group_ws_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."product_groups"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_group_idx" ON "products" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_id_ws_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
-- Product groups: metadata is member-visible (like releases/statuses); writes
-- are org-admin only. Roll-up aggregate filtering (hide groups with zero
-- readable products, count only readable products) lives in the app layer;
-- the numbers themselves stay protected by the product policies on features.
ALTER TABLE "product_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_groups_member_select ON "product_groups"
  FOR SELECT USING (specboard_is_member(workspace_id));--> statement-breakpoint
CREATE POLICY product_groups_admin_insert ON "product_groups"
  FOR INSERT WITH CHECK (specboard_is_org_admin(workspace_id));--> statement-breakpoint
CREATE POLICY product_groups_admin_update ON "product_groups"
  FOR UPDATE USING (specboard_is_org_admin(workspace_id))
  WITH CHECK (specboard_is_org_admin(workspace_id));--> statement-breakpoint
CREATE POLICY product_groups_admin_delete ON "product_groups"
  FOR DELETE USING (specboard_is_org_admin(workspace_id));
