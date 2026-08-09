-- Per-user GitHub tokens, so a spec commit can genuinely be the author's.
--
-- Until now every spec commit is authored by the App installation and the
-- author is named in a Co-authored-by trailer. That answers "who changed this"
-- but not "did they have the right to". A commit made with the person's own
-- token is authored by them, shows their avatar, and is subject to their own
-- repository permissions rather than the App's.
--
-- ── What is stored, and why this is the narrow version ──────────────────────
-- These are GitHub App *user-to-server* tokens, not tokens from a broad
-- `repo`-scoped OAuth app. A user-to-server token can only reach repositories
-- where the App is installed, and only with the intersection of the App's
-- permissions and the user's own. So connecting an account grants Specboards
-- nothing it did not already have; it narrows what a given write can do to
-- what that person could do by hand.
--
-- They are still credentials that can write to a customer's repository, which
-- is a class of secret this product has not held before. Both tokens are
-- encrypted at rest with the same AES-256-GCM helper used for the App private
-- key and webhook secret, so a database disclosure alone does not yield a
-- usable token.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
-- One row per user per workspace. Keyed by workspace as well as user because
-- everything else in this schema is, and because a connection is revoked when
-- someone leaves a workspace; a user-only row would outlive the membership
-- that justified it.
--
-- `github_login` is stored so the UI can say whose account is connected without
-- spending an API call, and so a mismatch (someone reconnecting a different
-- account) is visible rather than silent.
--
-- Expiry columns are nullable because App user tokens only expire when the App
-- has token expiration switched on. Null means "no known expiry", which the
-- refresh path treats as "use it and find out", since GitHub is the authority
-- either way.

CREATE TABLE IF NOT EXISTS "github_user_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "github_login" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "github_user_tokens_ws_user_uq" UNIQUE ("workspace_id", "user_id")
);

-- Scoped to the owning user, NOT merely to workspace membership.
--
-- Everything else in this schema gates on membership and leaves per-user
-- narrowing to the query layer (see saved_views), which is right for a saved
-- view and wrong for a credential. `infra/rls-role.sql` grants specboards_app
-- DML on future tables via ALTER DEFAULT PRIVILEGES, so this table is reachable
-- through the RLS-enforced connection the moment it exists; a membership-only
-- policy would let any colleague read or delete another person's token row the
-- first time any query touched this table. Nothing does today, and relying on
-- that is exactly the kind of assumption that stops being true quietly.
--
-- The write path uses the owner connection and so bypasses this entirely; the
-- policy is the backstop for every path that does not.
ALTER TABLE "github_user_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY github_user_tokens_own_all ON "github_user_tokens"
  FOR ALL USING (
    specboards_is_member(workspace_id)
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    specboards_is_member(workspace_id)
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

-- Deliberately NOT granted to specboards_worker. Sync and the webhook act for
-- the whole workspace with no acting user, so there is no person whose token
-- they could legitimately use, and a background job holding write credentials
-- for someone's repositories is exactly what this design avoids.
