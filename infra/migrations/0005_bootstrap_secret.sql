-- The secret that lets somebody claim a fresh instance.
--
-- A self-hosted deployment with no mail configured stopped requiring email
-- verification in PR #373, so that the operator could finish signing up at all
-- rather than being locked out by a link nothing could deliver. That fixed a
-- bricked first run and opened a different hole, which the card for this work
-- had already predicted: an instance reachable on the network that exempts its
-- first user hands workspace-owner rights to whoever finds the URL first.
--
-- The fix is to gate the first-run claim on a secret the operator already
-- holds by virtue of having deployed the thing, rather than on a mailbox they
-- may not have. Where none is configured, the instance generates one at first
-- boot and prints it to the log, which is the pattern GitLab and Grafana use
-- and which keeps `docker compose up` working with no configuration at all.
--
-- Only a hash is stored. The token is shown once, in the log of the boot that
-- generated it, so a database dump does not hand somebody an unclaimed
-- instance.
--
-- A deployment singleton with no workspace_id and no RLS, like github_app and
-- mail_settings: there is no workspace yet when this matters, which is the
-- whole point of it.

CREATE TABLE bootstrap_secret (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Pinned true and unique, so at most one row can ever exist. Two rows
    -- would mean two tokens, one of which silently does not work.
    singleton boolean NOT NULL DEFAULT true UNIQUE,
    CONSTRAINT bootstrap_secret_singleton_true CHECK (singleton),

    token_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Out of the tenant role's reach, for the same reason mail_settings is: this
-- is deployment configuration reached on the owner connection, and there is no
-- workspace column for a policy to key on. A hash is not directly usable, but
-- a tenant connection has no business reading or writing it either way.
--
-- `infra/rls-role.sql` grants specboards_app every table in the schema and
-- re-grants them each time it runs, so the same revoke is in that file too.
-- Both are needed: this one for a database already migrated, that one for
-- every future run.
--
-- Guarded on the role existing. Migrations run against a bare Postgres in CI
-- and on a fresh install, where `infra/rls-role.sql` has not created the role
-- yet, and REVOKE on a role that does not exist is an error rather than a
-- no-op. Same shape as the worker grants in migrations 0002 and 0003.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
        REVOKE ALL ON bootstrap_secret FROM specboards_app;
    END IF;
END $$;
