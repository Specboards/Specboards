ALTER TABLE "workspace_properties" DROP CONSTRAINT "workspace_properties_ws_key_uq";--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_properties" ADD COLUMN "entity" text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_properties" ADD CONSTRAINT "workspace_properties_ws_entity_key_uq" UNIQUE("workspace_id","entity","key");