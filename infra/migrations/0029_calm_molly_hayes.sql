CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"actor_id" uuid,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_ws_idx" ON "outbox_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outbox_events_created_idx" ON "outbox_events" USING btree ("created_at");--> statement-breakpoint
-- The relay claims unprocessed rows oldest-first; a partial index keeps that scan
-- cheap as processed rows accumulate.
CREATE INDEX "outbox_events_unprocessed_idx" ON "outbox_events" USING btree ("created_at") WHERE "processed_at" IS NULL;--> statement-breakpoint
-- RLS: an outbox row is visible/writable only to members of its workspace
-- (writes happen in-tx on the app connection; the relay reads on the owner
-- connection, which bypasses RLS). Mirrors webhook_endpoints in 0028.
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY outbox_events_member_all ON "outbox_events"
  FOR ALL USING (specboard_is_member(workspace_id))
  WITH CHECK (specboard_is_member(workspace_id));