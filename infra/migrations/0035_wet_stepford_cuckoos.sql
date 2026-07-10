CREATE TABLE "github_install_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" text,
	"account_login" text,
	"account_type" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_install_states_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN "client_secret" text;--> statement-breakpoint
ALTER TABLE "github_install_states" ADD CONSTRAINT "github_install_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_install_states_expires_idx" ON "github_install_states" USING btree ("expires_at");