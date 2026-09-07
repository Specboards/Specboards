-- Notification settings: a workspace's defaults, and each user's departures
-- from them.
--
-- Both tables store OVERRIDES ONLY. A resolution walks catalog default ->
-- workspace default -> user preference, and an absent row at either level
-- means "inherit", resolved at read time. Nothing is seeded, at workspace
-- creation or at signup: rows written up front would pin every user to the
-- value that was current on the day they joined, and an admin changing a
-- default afterwards would move nobody. That is the behaviour this shape
-- exists to avoid, and it fails silently, so the absence of a seed step is the
-- point rather than an omission.
--
-- One row per (scope, event type, channel) rather than a column per channel:
-- adding a channel then costs a catalog entry instead of a migration, and
-- `frequency` gets to be per channel. Nothing reads `frequency` yet (email
-- ships immediate-only); the column is here so a digest arrives without one of
-- these files.

CREATE TABLE notification_defaults (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Text rather than an enum, in both tables and both columns. The catalog
    -- in lib/notifications/catalog.ts is the authority on what a valid event
    -- type or channel is, and an enum here would mean a migration every time
    -- it gained a member. A row naming a type the catalog no longer has is
    -- ignored on read rather than being a constraint violation, which is what
    -- lets a type be retired without rewriting everybody's settings.
    event_type text NOT NULL,
    channel text NOT NULL,
    enabled boolean NOT NULL,
    frequency text NOT NULL DEFAULT 'immediate',
    -- Snapshot, no FK: a default outlives the admin who set it.
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_defaults_row_uq UNIQUE (workspace_id, event_type, channel)
);
--> statement-breakpoint

CREATE TABLE notification_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- No FK to users, matching `notifications.recipient_id`. Membership is
    -- what gates access to these rows, and it is enforced by the policies
    -- below rather than by referential integrity.
    user_id uuid NOT NULL,
    event_type text NOT NULL,
    channel text NOT NULL,
    enabled boolean NOT NULL,
    frequency text NOT NULL DEFAULT 'immediate',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_preferences_row_uq UNIQUE (workspace_id, user_id, event_type, channel)
);
--> statement-breakpoint

-- The admin grid reports how many people have overridden each row, which asks
-- by (workspace, event type, channel). The unique constraint's index cannot
-- serve that: the user id sits in the middle of it.
CREATE INDEX notification_preferences_row_idx
    ON notification_preferences (workspace_id, event_type, channel);
--> statement-breakpoint

ALTER TABLE notification_defaults ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Defaults: every member reads them, only an org admin writes them.
--
-- The read is deliberately open to the whole workspace rather than to admins.
-- A member's own settings screen shows each row it has not overridden as
-- "inherited" next to the value it is inheriting, and it cannot show that
-- value without reading this table. Same shape as product_repositories.
CREATE POLICY notification_defaults_member_select ON notification_defaults
    FOR SELECT USING (public.specboards_is_member(workspace_id));
--> statement-breakpoint
CREATE POLICY notification_defaults_admin_insert ON notification_defaults
    FOR INSERT WITH CHECK (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint
CREATE POLICY notification_defaults_admin_update ON notification_defaults
    FOR UPDATE USING (public.specboards_is_org_admin(workspace_id))
    WITH CHECK (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint
CREATE POLICY notification_defaults_admin_delete ON notification_defaults
    FOR DELETE USING (public.specboards_is_org_admin(workspace_id));
--> statement-breakpoint

-- Preferences: yours and nobody else's, in either direction. An admin has no
-- read here either, which is why the override *count* they see is an
-- aggregate computed on the owner connection rather than a query they could
-- run themselves. Same predicate as `notifications`.
CREATE POLICY notification_preferences_own_select ON notification_preferences
    FOR SELECT USING (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint
CREATE POLICY notification_preferences_own_insert ON notification_preferences
    FOR INSERT WITH CHECK (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint
CREATE POLICY notification_preferences_own_update ON notification_preferences
    FOR UPDATE USING (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    ) WITH CHECK (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint
CREATE POLICY notification_preferences_own_delete ON notification_preferences
    FOR DELETE USING (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint

-- How many members have departed from each default.
--
-- An admin needs this to see a default nobody accepts, and must not be able to
-- see the rows behind it: whether one named person mutes their mentions is
-- theirs, and the policies above say so by scoping every read to the owning
-- user. Column-level privileges cannot express "the count but not the rows",
-- so this is a SECURITY DEFINER function that returns only the aggregate.
--
-- It re-checks the caller itself rather than trusting whoever calls it.
-- Definer rights mean the RLS on the table underneath does not apply, so this
-- predicate is the only thing standing between a member and a tally of their
-- colleagues' settings. A non-admin gets an empty result rather than an error,
-- which is the same answer a workspace with no overrides gives, and the admin
-- check on the read path is what turns that into a refusal they can read.
--
-- `search_path` is pinned, as every SECURITY DEFINER function here is: without
-- it, a caller who can create a schema earlier in their own search_path can
-- shadow `members` and decide for themselves whether they are an admin.
CREATE FUNCTION public.specboards_notification_override_counts(target_workspace uuid)
    RETURNS TABLE (event_type text, channel text, n bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
  SELECT p.event_type, p.channel, count(*)
  FROM notification_preferences p
  WHERE p.workspace_id = target_workspace
    AND public.specboards_is_org_admin(target_workspace)
  GROUP BY p.event_type, p.channel;
$fn$;
--> statement-breakpoint

-- The relay resolves channels inside its per-event transaction, so the worker
-- role needs to read both tables. Granted here as well as in
-- infra/worker-role.sql because that file is run by hand once per database:
-- on a fresh install the role does not exist yet and this block is skipped,
-- and on an existing database the role does exist and this grant is what makes
-- the fan-out honour preferences the moment the migration lands, rather than
-- when somebody remembers to re-run the role script.
--
-- Read-only, both tables. The worker asks what a user wants and never records
-- an answer.
--
-- The role-targeted policies are what actually give it cross-workspace reach:
-- the relay runs with no `app.user_id`, so the member and owner predicates
-- above match zero rows for it. See infra/worker-role.sql for why a policy
-- targeted at a role is safe for the app role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT ON notification_defaults TO specboards_worker;
        GRANT SELECT ON notification_preferences TO specboards_worker;

        DROP POLICY IF EXISTS notification_defaults_worker_all ON notification_defaults;
        CREATE POLICY notification_defaults_worker_all ON notification_defaults
            FOR ALL TO specboards_worker USING (true) WITH CHECK (true);

        DROP POLICY IF EXISTS notification_preferences_worker_all ON notification_preferences;
        CREATE POLICY notification_preferences_worker_all ON notification_preferences
            FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
    END IF;
END $$;
