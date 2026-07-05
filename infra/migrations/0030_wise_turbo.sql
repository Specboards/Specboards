CREATE TABLE "doc_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"area" text NOT NULL,
	"parent_id" uuid,
	"kind" text DEFAULT 'page' NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"area" text NOT NULL,
	"mode" text NOT NULL,
	"external_url" text,
	"repo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_spaces_product_area_uq" UNIQUE("product_id","area")
);
--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_parent_id_doc_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_spaces" ADD CONSTRAINT "doc_spaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_spaces" ADD CONSTRAINT "doc_spaces_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_spaces" ADD CONSTRAINT "doc_spaces_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_pages_product_area_idx" ON "doc_pages" USING btree ("product_id","area");--> statement-breakpoint
CREATE INDEX "doc_pages_ws_idx" ON "doc_pages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "doc_pages_parent_idx" ON "doc_pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "doc_spaces_ws_idx" ON "doc_spaces" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "doc_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY doc_spaces_member_all ON "doc_spaces"
  FOR ALL USING (specboard_is_member(workspace_id))
  WITH CHECK (specboard_is_member(workspace_id));--> statement-breakpoint
ALTER TABLE "doc_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY doc_pages_member_all ON "doc_pages"
  FOR ALL USING (specboard_is_member(workspace_id))
  WITH CHECK (specboard_is_member(workspace_id));
