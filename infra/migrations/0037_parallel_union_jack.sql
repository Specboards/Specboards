CREATE TABLE "mcp_workspace_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_workspace_bindings_user_client_key" UNIQUE("user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_workspace_bindings" ADD CONSTRAINT "mcp_workspace_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_workspace_bindings" ADD CONSTRAINT "mcp_workspace_bindings_client_id_oauth_applications_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_applications"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_workspace_bindings" ADD CONSTRAINT "mcp_workspace_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_workspace_bindings_workspace_idx" ON "mcp_workspace_bindings" USING btree ("workspace_id");