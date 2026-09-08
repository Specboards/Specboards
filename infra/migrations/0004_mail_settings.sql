-- How this deployment sends mail.
--
-- Outbound mail was Postmark or nothing: `apps/web/src/lib/email.ts` posted
-- straight to api.postmarkapp.com with a token from env, and there was no other
-- transport and no configuration surface. A customer running Specboards on
-- their own infrastructure had no supported way to make transactional email
-- work, and an air-gapped install could not reach Postmark at all, so mail was
-- not degraded there but impossible.
--
-- A deployment singleton, like `github_app`: no workspace_id, no RLS, reached
-- only on the owner connection. That is a security property rather than a
-- shortcut. Mail transport is the credential every transactional message leaves
-- through, so a per-workspace version of this table would let any workspace
-- owner on a multi-tenant deployment re-point every other tenant's verification
-- and invitation mail at a relay they control. There is one mail transport per
-- deployment because there is one operator per deployment. The app enforces the
-- same thing a second way by refusing to serve this surface at all when the
-- deployment is multi-tenant; see `lib/mail/config.ts`.

CREATE TABLE mail_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Pinned true and unique, so at most one row can ever exist. Enforced here
    -- rather than left to the reader taking the first row it finds: a second
    -- row that was silently ignored would present as "I saved the settings and
    -- nothing changed", which is the worst kind of support call.
    singleton boolean NOT NULL DEFAULT true UNIQUE,
    CONSTRAINT mail_settings_singleton_true CHECK (singleton),

    -- Text rather than an enum, matching the notification catalog's reasoning:
    -- a new transport should be a code change, not a migration.
    transport text NOT NULL,
    CONSTRAINT mail_settings_transport_known
        CHECK (transport IN ('postmark', 'smtp')),

    from_address text NOT NULL,

    -- Encrypted at rest (AES-256-GCM keyed off BETTER_AUTH_SECRET), the same
    -- treatment github_app.private_key and a model provider's API key get.
    -- Never returned to the client once saved.
    postmark_token text,

    smtp_host text,
    smtp_port integer,
    -- 'tls' (implicit, usually 465), 'starttls' (usually 587), or 'none'.
    smtp_security text,
    smtp_username text,
    smtp_password text,
    CONSTRAINT mail_settings_smtp_security_known
        CHECK (smtp_security IS NULL
               OR smtp_security IN ('tls', 'starttls', 'none')),

    -- Each transport needs its own fields present. Checked here as well as in
    -- the service so a row cannot be written that the sender would then fail on
    -- at the moment somebody is waiting for a verification link.
    CONSTRAINT mail_settings_transport_complete CHECK (
        (transport = 'postmark' AND postmark_token IS NOT NULL)
     OR (transport = 'smtp'
         AND smtp_host IS NOT NULL
         AND smtp_port IS NOT NULL
         AND smtp_security IS NOT NULL)
    ),

    -- Which admin last saved it; snapshot, no FK, so the setting outlives them.
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- No ENABLE ROW LEVEL SECURITY, deliberately, and no grant to specboards_app.
--
-- Both are the same decision as `github_app`. This row is deployment
-- configuration rather than tenant data, so it is reached on the owner
-- connection by a small number of admin-gated server paths, and the tenant
-- connection has no business seeing a decrypted-on-read credential at all. RLS
-- would be the wrong tool here: there is no workspace column to key it on, and
-- adding one would create exactly the per-tenant transport this table exists to
-- avoid.
--
-- `infra/rls-role.sql` grants specboards_app select/insert/update/delete on
-- ALL tables in the schema, so this REVOKE is what keeps the tenant role out on
-- a database that has already been provisioned.
--
-- It is not sufficient on its own. That script re-grants every table each time
-- it runs, and the runbook says re-running it is safe, so a revoke that lived
-- only here would come undone the next time somebody followed that advice. The
-- same revoke is therefore in `infra/rls-role.sql`, after its blanket grant.
-- Both are needed: this one for a database already migrated, that one for every
-- future run. `apps/web/src/lib/mail/settings.int.test.ts` applies that script
-- and then checks the privilege, which is how the gap was found.
--
-- Guarded on the role existing. Migrations run against a bare Postgres in CI
-- and on a fresh install, where `infra/rls-role.sql` has not created
-- specboards_app yet, and REVOKE on a role that does not exist is an error
-- rather than a no-op. That is not a hypothetical: the unguarded version
-- passed locally, where an integration test had already created the role, and
-- failed the first CI run on a clean database. Same shape as the worker grants
-- in migrations 0002 and 0003.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
        REVOKE ALL ON mail_settings FROM specboards_app;
    END IF;
END $$;
