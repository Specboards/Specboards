-- Where a workspace's own inference lives. First schema in the product that
-- knows what a model is.
--
-- The shape is "any OpenAI-compatible endpoint", which is one adapter rather
-- than one per vendor: OpenAI, Groq, Together, OpenRouter and Anthropic's
-- compatibility endpoint all speak it, and so do vLLM, Ollama and the corporate
-- gateways on-prem customers put in front of their own weights. A native
-- per-vendor adapter is a later decision, taken when something actually needs a
-- capability this shape cannot express, so `kind` exists to make that additive.
--
-- ── Why the credential is a second table ────────────────────────────────────
-- The obvious design puts an encrypted `api_key` column on `model_providers`,
-- which is what `webhook_endpoints.secret` and `github_apps.private_key` do.
-- It is deliberately not done here. Credential storage, rotation and revocation
-- are their own feature in this epic, and it is going to want things a column
-- cannot give it: a rotation that writes the new secret before retiring the old
-- one, a per-credential last-used and created-at, and the option of moving the
-- material out of Postgres entirely behind an external reference. Splitting it
-- now costs one FK and means that feature does not need a second migration to
-- reshape a table the assistant is by then reading on every request.
--
-- It also buys column-level protection that RLS cannot express. The provider
-- row (base URL, model, enabled) is ordinary configuration any member's request
-- may resolve; the secret is not. As two tables that is two policies. As one
-- table it would be one policy, and the only safe choice would be to lock the
-- whole row to owners, which would put the credential's blast radius around the
-- base URL as well.
--
-- ── Why the key is nullable ─────────────────────────────────────────────────
-- A locally hosted endpoint frequently has no key at all: `ollama serve` and a
-- default vLLM listener accept unauthenticated requests from the network they
-- are on. Requiring a credential would force customers to invent a fake one,
-- so "no credential" is a first-class state and `credential_id` is nullable.
--
-- ── One connection per workspace ────────────────────────────────────────────
-- Enforced by a unique index rather than by convention, so resolution is a
-- single unambiguous row and no code has to pick a winner. Several connections
-- per workspace (a cheap model for one job, a strong one for another) is a
-- plausible future, and relaxing a unique index is a much smaller migration
-- than repairing rows that accumulated while nothing enforced the assumption.

CREATE TABLE "model_provider_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- AES-256-GCM blob from `encryptSecret`, the same helper that holds the
  -- GitHub App private key and webhook signing secrets. Never leaves the server.
  "secret" text NOT NULL,
  -- Last 4 characters, for the UI to show "sk-...a91c" without the value. Stored
  -- rather than derived because deriving it means decrypting, and the settings
  -- page has no business decrypting anything to render a list.
  "hint" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  -- Declared here rather than as a later ALTER because the composite FK on
  -- `model_providers` below references these two columns, and Postgres requires
  -- the unique constraint to exist before the FK that points at it.
  CONSTRAINT "model_provider_credentials_id_ws_uq" UNIQUE ("id", "workspace_id")
);--> statement-breakpoint

CREATE TABLE "model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- The wire protocol, not the vendor. Only one shape today; the column exists
  -- so adding a native adapter later is an INSERT concern rather than a schema
  -- change on a table the assistant reads constantly.
  "kind" text NOT NULL DEFAULT 'openai_compatible',
  -- Endpoint root, e.g. https://api.openai.com/v1 or http://10.0.0.4:8000/v1.
  -- Validated against the egress policy on write, and again before every call:
  -- a row written while a deployment allowed private targets must not keep
  -- working after that policy is tightened.
  "base_url" text NOT NULL,
  -- The model id passed through to the endpoint verbatim. We do not maintain a
  -- catalogue: a self-hosted runtime serves whatever it was started with, and a
  -- hardcoded list would be wrong for exactly the customers this epic is for.
  "model" text NOT NULL,
  -- NULL is a real state, not a missing value: see the note above. The FK is
  -- declared once, as the composite below, since that one is strictly stronger
  -- than a plain reference to `id` and a second overlapping constraint would
  -- only be one more thing to keep in step.
  "credential_id" uuid,
  "enabled" boolean DEFAULT true NOT NULL,
  -- Set on each successful completion, so an admin can tell a live connection
  -- from one configured months ago and never exercised.
  "last_used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_providers_kind_check"
    CHECK ("kind" IN ('openai_compatible')),
  -- A credential must belong to the same workspace as the provider using it, so
  -- a tenant cannot be handed a row that points at another tenant's secret.
  --
  -- The column list on SET NULL is load-bearing, not decoration. Without it
  -- Postgres nulls EVERY referencing column on delete, including
  -- `workspace_id`, which is NOT NULL: deleting a credential then fails with a
  -- constraint violation and taking a key off a connection becomes impossible.
  -- Requires Postgres 15+; test runs 17.2, production 17.7, CI 16.
  CONSTRAINT "model_providers_credential_ws_fk"
    FOREIGN KEY ("credential_id", "workspace_id")
    REFERENCES "model_provider_credentials"("id", "workspace_id")
    ON DELETE SET NULL ("credential_id")
);--> statement-breakpoint

CREATE UNIQUE INDEX "model_providers_ws_uq" ON "model_providers" ("workspace_id");--> statement-breakpoint
CREATE INDEX "model_provider_credentials_ws_idx"
  ON "model_provider_credentials" ("workspace_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS.
--
-- Provider rows: any member may read. The assistant will resolve the workspace
-- connection on behalf of whoever is using it, and that read carries nothing
-- secret. Writes are org-admin only, because configuring this spends the
-- customer's money at a vendor we have no relationship with.
--
-- Credential rows: org admin for everything, including SELECT. No member-facing
-- path has a reason to read one, and the completion path decrypts server-side
-- in a context that is already owner-gated. This is the same reasoning as
-- `github_user_tokens` in 0059: `infra/rls-role.sql` grants the app role DML on
-- future tables automatically, so a table with no policy of its own is reachable
-- the moment it exists, and "nothing queries it today" is precisely the
-- assumption that stops being true without anyone noticing.
--
-- ── These policies do not run on the connection the routes use ─────────────
-- Written for `specboards_app` (DATABASE_URL_APP), which is not what reaches
-- these tables. Every model-provider route resolves `getDb()`, the owner
-- connection, and an owner is exempt from RLS unless the table carries FORCE
-- ROW LEVEL SECURITY, which nothing sets. What actually confines a request to
-- its tenant here is the `workspaceId` predicate in `model-provider-service.ts`
-- and the org-admin check in the route.
--
-- The rules above are therefore the intended rules, held ready, not the
-- enforced ones. Anyone moving these routes onto the app connection should read
-- the note on `getDb()` in apps/web/src/lib/db.ts first: the credential SELECT
-- below is org-admin only and runs inside an ordinary member's assistant
-- request, so a naive move silently breaks the assistant for everyone who is
-- not an admin.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "model_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY model_providers_read ON "model_providers"
  FOR SELECT USING (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY model_providers_write ON "model_providers"
  FOR ALL USING (specboards_is_org_admin("workspace_id"))
  WITH CHECK (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

CREATE POLICY model_provider_credentials_admin ON "model_provider_credentials"
  FOR ALL USING (specboards_is_org_admin("workspace_id"))
  WITH CHECK (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

-- Table privileges for the app connection. `infra/rls-role.sql` sets ALTER
-- DEFAULT PRIVILEGES so new tables are reachable automatically, but the live
-- test and prod clusters predate that script and use a `writer` group role with
-- per-table grants instead. Without this a new table is invisible to
-- specboards_app on exactly the two databases that matter, and the failure mode
-- is the one #257 cost us: the statement runs, the privilege check fails, and
-- the save dies with aclcheck_error. Guarded on existence, so it costs nothing.
--
-- Deliberately NOT granted to specboards_worker. Sync and the webhook drainer
-- act for a whole workspace with no acting user; neither has any reason to call
-- a model, and a background job holding a customer's inference credentials is
-- what this split exists to avoid.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "model_providers" TO writer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "model_provider_credentials" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "model_providers" TO specboards_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "model_provider_credentials" TO specboards_app;
  END IF;
END $$;
