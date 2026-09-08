-- An explicit watch relationship between a person and an item.
--
-- Recipient resolution could only ever reach the people the data already
-- names: the assignee, the comment author, the person mentioned. Somebody who
-- cares about an item they do not own had no way to be told, and somebody
-- stuck on a thread they no longer care about had no way to leave.
--
-- The row carries `watching` rather than existing-or-not, because "I am not
-- watching this" has to be something the table can say. The item you are
-- assigned to is followed by default, so leaving it needs a recorded decision;
-- without one the only way to stop hearing about an item would be to give it
-- away, which is the lever the preference grid deliberately does not have. It
-- is the same column that keeps auto-watch leaveable: the auto rules insert
-- with ON CONFLICT DO NOTHING, so a row saying no survives every later reason
-- the system might have had to add somebody back.

CREATE TABLE item_watchers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    feature_id uuid NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    -- No FK to users, matching notifications.recipient_id. Membership is what
    -- gates these rows, and the policies below enforce it.
    user_id uuid NOT NULL,
    watching boolean NOT NULL DEFAULT true,
    -- Whether the watch also covers everything under the item. Named for what
    -- it means rather than "cascade", which is a keyword here.
    include_descendants boolean NOT NULL DEFAULT false,
    -- 'manual' or 'auto'. Text rather than an enum for the same reason the
    -- notification tables use text: a new source should not need a migration.
    source text NOT NULL DEFAULT 'manual',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT item_watchers_uq UNIQUE (workspace_id, feature_id, user_id)
);
--> statement-breakpoint

-- The fan-out asks "who watches these items", per event.
CREATE INDEX item_watchers_feature_idx ON item_watchers (feature_id);
--> statement-breakpoint
-- The detail view asks "am I watching this", and a future "items I watch" list
-- asks the same question the other way round.
CREATE INDEX item_watchers_user_idx ON item_watchers (workspace_id, user_id);
--> statement-breakpoint

ALTER TABLE item_watchers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Readable by the whole workspace: the watcher list is visible, which answers
-- the card's other open question. A count that nobody can see does not tell an
-- author that anyone is listening, and every issue tracker people already use
-- shows this. Product visibility is not re-checked here because the item id is
-- only reachable through a read of the item itself, which is filtered.
CREATE POLICY item_watchers_member_select ON item_watchers
    FOR SELECT USING (public.specboards_is_member(workspace_id));
--> statement-breakpoint

-- Writable only for yourself.
--
-- The one place this bites is auto-watch on assignment, where the person doing
-- the assigning is not the person who ends up watching. That is deliberately
-- not solved by loosening this policy: a member able to insert a watch row for
-- anybody could subscribe a colleague to an item they have no interest in, and
-- the notification would look like the product's doing rather than theirs. The
-- auto rules run in the relay instead, on the worker role, which is the same
-- place that already decides who a notification is for.
CREATE POLICY item_watchers_own_insert ON item_watchers
    FOR INSERT WITH CHECK (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint
CREATE POLICY item_watchers_own_update ON item_watchers
    FOR UPDATE USING (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    ) WITH CHECK (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint
CREATE POLICY item_watchers_own_delete ON item_watchers
    FOR DELETE USING (
        public.specboards_is_member(workspace_id)
        AND (user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)
    );
--> statement-breakpoint

-- The relay reads watchers to resolve recipients, and writes the auto-watch
-- rows described above, so this is the one worker grant in the notification
-- path that is not read-only. It can add somebody to an item they were just
-- assigned, or just commented on; it cannot delete a row, so it can never
-- undo a decision a person made about their own attention.
--
-- Granted here as well as in infra/worker-role.sql for the same reason as
-- migration 0002: that file is run by hand once per database, and this makes
-- an already-provisioned database work the moment the migration lands.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT, INSERT, UPDATE ON item_watchers TO specboards_worker;

        DROP POLICY IF EXISTS item_watchers_worker_all ON item_watchers;
        CREATE POLICY item_watchers_worker_all ON item_watchers
            FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
    END IF;
END $$;
