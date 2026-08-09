-- Tell the author what happened to the change they proposed.
--
-- A non-technical author does not watch the repo and will never see GitHub's
-- own notification, so today a spec change they made simply stops being
-- mentioned. Merged and closed both need saying, and the closed case needs it
-- more: a change that quietly evaporated is worse than one that was turned down
-- out loud, because the author goes on believing it landed.
--
-- Three changes, each forced by something the notifications table assumed.
--
-- 1. `comment_id` was NOT NULL because every notification so far came from an
--    @mention. A review outcome has no comment behind it. Made nullable rather
--    than inventing a placeholder comment, which would appear in comment counts
--    and threads as a message nobody wrote.
--
-- 2. `feature_github_links.author_id` records who opened a proposal. Nothing
--    stored it before: `head_branch` marks a link as a spec change but says
--    nothing about whose it was, and a notification with no addressee cannot be
--    sent. Snapshot with no FK, matching how `actor_id` already behaves here: a
--    departed author's history must still render.
--
-- 3. The worker needs to write notifications. The pull request webhook is the
--    only place that learns an outcome, and it runs as `specboards_worker`.
--
-- Same reasoning as 0056 for putting the grant in a migration as well as in
-- `infra/worker-role.sql`: that file stays the readable source of truth for the
-- worker's surface, and this repeats it so a deploy cannot leave the webhook
-- unable to write. INSERT and SELECT only; the worker raises notifications and
-- never reads or clears anyone's inbox.

ALTER TABLE "notifications" ALTER COLUMN "comment_id" DROP NOT NULL;

ALTER TABLE "feature_github_links" ADD COLUMN "author_id" uuid;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
    GRANT SELECT, INSERT ON "notifications" TO specboards_worker;

    -- The worker spans every workspace and runs with no `app.user_id`, so the
    -- recipient policy matches zero rows for it. A role-targeted policy is only
    -- evaluated when the connected role IS specboards_worker, so this grants
    -- cross-workspace access without loosening anything for specboards_app.
    DROP POLICY IF EXISTS notifications_worker_all ON "notifications";
    CREATE POLICY notifications_worker_all ON "notifications"
      FOR ALL TO specboards_worker USING (true) WITH CHECK (true);
  END IF;
END $$;
