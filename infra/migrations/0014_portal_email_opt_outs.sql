-- Somewhere for a person with no account to say "stop emailing me".
--
-- The portal now writes to two audiences that have no user row: the people who
-- submit ideas, and the people who vote for them. Both are about to start
-- receiving mail when an idea they care about changes state, and every one of
-- those messages needs an unsubscribe link that works.
--
-- ── Why the existing switch cannot be reused ───────────────────────────────
-- `users.notification_email_opted_out_at` is the master switch for people with
-- accounts, and it is a column on a row these recipients do not have. There is
-- nowhere on `ideas` to put it either: an opt-out is a statement about a
-- PERSON, and the same address may have submitted one idea and voted on nine.
-- Recording it per idea would mean unsubscribing nine times.
--
-- ── Scoped to a workspace, not global ──────────────────────────────────────
-- The key is (workspace_id, email), so unsubscribing from one customer's portal
-- says nothing about another's. A visitor who asked Acme to stop emailing them
-- has not asked Acme's competitor anything, and an unsubscribe link in a mail
-- sent by Acme that silently muted a third party would be the wrong reading of
-- what they clicked.
--
-- The cost is that somebody active on several portals may unsubscribe several
-- times. That is the correct number of decisions for them to make.
CREATE TABLE portal_email_opt_outs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Case-folded, and unique per workspace.
--
-- The same reasoning as `idea_votes_idea_email_uq` in 0010: an address is one
-- person however they capitalised it, and the alternative is that unsubscribing
-- as `Ada@` leaves mail flowing to `ada@`. Unique so that clicking the link
-- twice is idempotent rather than an accumulation of rows the reader has to
-- de-duplicate.
CREATE UNIQUE INDEX portal_email_opt_outs_ws_email_uq
    ON portal_email_opt_outs (workspace_id, lower(email));
--> statement-breakpoint

COMMENT ON TABLE portal_email_opt_outs IS
    'Addresses that have unsubscribed from one workspace''s portal mail. Keyed per workspace: unsubscribing from one customer''s portal says nothing about another''s.';
--> statement-breakpoint

ALTER TABLE portal_email_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Members of the workspace, matching `idea_settings_member_all`. This is a list
-- of that workspace's own correspondents, so its admins may read it; nobody
-- else may.
--
-- Note what is NOT here: any policy admitting the PORTAL role. The portal reads
-- published ideas for anonymous visitors and has no business knowing who has
-- unsubscribed, which would be a list of addresses reachable from a public
-- page. The unsubscribe write happens on the owner connection instead, exactly
-- as the existing one-click unsubscribe does, because it carries no session and
-- the signed token in the URL is the authorization.
CREATE POLICY portal_email_opt_outs_member_all ON portal_email_opt_outs
    USING (public.specboards_is_member(workspace_id))
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

-- ── The relay's reach ──────────────────────────────────────────────────────
--
-- The notification relay is what actually sends this mail, and it runs as
-- `specboards_worker` with no `app.user_id`, so it needs role-targeted policies
-- and explicit grants like every other table on its surface.
--
-- Three tables it could not previously touch:
--
--   `ideas`          - to know the title and state of the idea being announced.
--   `idea_votes`     - to find who voted, INCLUDING `voter_email`. That column
--                      is deliberately unreadable by the portal role (0010),
--                      and the relay is the one place that has to read it: it
--                      is the address the mail goes to. Narrow and on purpose,
--                      not a relaxation of that decision.
--   `portal_email_opt_outs` - to honour it.
--
-- SELECT only, on all three. The relay reads a decision somebody made and never
-- records one, which is the same bargain migration 0006 struck when the worker
-- was first allowed to read `users.notification_email_opted_out_at`.
--
-- Granted here as well as in infra/worker-role.sql for the reason migrations
-- 0002, 0003 and 0007 give: that file is run by hand once per database, and
-- this makes an already-provisioned database correct the moment the migration
-- lands rather than the next time somebody remembers to re-run it.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
        GRANT SELECT ON ideas, idea_votes, portal_email_opt_outs TO specboards_worker;

        DROP POLICY IF EXISTS ideas_worker_read ON ideas;
        CREATE POLICY ideas_worker_read ON ideas
            FOR SELECT TO specboards_worker USING (true);

        DROP POLICY IF EXISTS idea_votes_worker_read ON idea_votes;
        CREATE POLICY idea_votes_worker_read ON idea_votes
            FOR SELECT TO specboards_worker USING (true);

        DROP POLICY IF EXISTS portal_email_opt_outs_worker_read ON portal_email_opt_outs;
        CREATE POLICY portal_email_opt_outs_worker_read ON portal_email_opt_outs
            FOR SELECT TO specboards_worker USING (true);
    END IF;
END $$;
