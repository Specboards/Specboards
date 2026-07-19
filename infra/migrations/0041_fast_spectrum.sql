ALTER TABLE "releases" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: releases were workspace-wide. Assign each to its workspace's product
-- when the workspace has exactly one product (all current data). Multi-product
-- workspaces keep product_id NULL (portfolio) rather than guessing.
UPDATE "releases" r SET "product_id" = p."id"
FROM "products" p
WHERE p."workspace_id" = r."workspace_id"
  AND (SELECT count(*) FROM "products" p2 WHERE p2."workspace_id" = r."workspace_id") = 1;--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "releases_ws_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "releases_product_name_uq" ON "releases" USING btree ("product_id","name") WHERE "releases"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_ws_portfolio_name_uq" ON "releases" USING btree ("workspace_id","name") WHERE "releases"."product_id" is null;--> statement-breakpoint
CREATE INDEX "releases_product_idx" ON "releases" USING btree ("product_id");
