CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text DEFAULT 'mention' NOT NULL,
	"feature_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"snippet" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_comment_idx" ON "notifications" USING btree ("comment_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS: notifications are personal. You only ever read or update your own
-- rows (recipient = the per-transaction app.user_id), so no one can see whom
-- else was mentioned. Inserts are allowed for any workspace member because
-- mention fan-out writes rows targeting *other* users (the recipients), in the
-- same transaction as the comment. Membership is still required on every path.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notifications_read ON "notifications"
  FOR SELECT USING (
    specboard_is_member(workspace_id)
    AND recipient_id = nullif(current_setting('app.user_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY notifications_insert ON "notifications"
  FOR INSERT WITH CHECK (specboard_is_member(workspace_id));--> statement-breakpoint
CREATE POLICY notifications_update ON "notifications"
  FOR UPDATE USING (
    specboard_is_member(workspace_id)
    AND recipient_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    specboard_is_member(workspace_id)
    AND recipient_id = nullif(current_setting('app.user_id', true), '')::uuid
  );--> statement-breakpoint
CREATE POLICY notifications_delete ON "notifications"
  FOR DELETE USING (
    specboard_is_member(workspace_id)
    AND recipient_id = nullif(current_setting('app.user_id', true), '')::uuid
  );