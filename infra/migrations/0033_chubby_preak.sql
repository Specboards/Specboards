CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'viewer' NOT NULL,
	"token_hash" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_ws_idx" ON "invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitations_token_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint

-- At most one *live* invitation per (workspace, email). Partial-unique so that
-- revoked/accepted/expired rows don't block re-inviting the same address.
-- Hand-added: Drizzle's table builder can't express a partial-unique index.
CREATE UNIQUE INDEX "invitations_ws_email_pending_uq"
  ON "invitations" (workspace_id, lower(email)) WHERE status = 'pending';--> statement-breakpoint

-- Deactivated members lose all access: a suspended row must no longer count as
-- membership. Redefining the RLS helper folds this into every tenant policy at
-- once (defense in depth; the app-layer getMembership filter enforces it today,
-- since the app still connects as the table owner and bypasses RLS).
CREATE OR REPLACE FUNCTION specboard_is_member(target_workspace uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.deactivated_at IS NULL
  );
$$;--> statement-breakpoint

-- Tenant isolation for invitations: an admin only ever sees their own org's
-- invites. The accept-by-token read runs pre-membership on the owner
-- connection, which bypasses RLS by design.
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY invitations_member_all ON "invitations"
  FOR ALL USING (specboard_is_member(workspace_id))
  WITH CHECK (specboard_is_member(workspace_id));