-- Whether an idea is published on the portal, as a fact about the idea.
--
-- Publication has so far been derived entirely from the visibility model: an
-- idea appears if its product is published and its review stage is published.
-- That is a rule about CATEGORIES, and moderation is a decision about ONE row.
-- There is no way to express "this particular submission is spam" or "this one
-- is not ready to show" without withdrawing a whole stage from the portal and
-- taking every other idea at that stage down with it.
--
-- ── Distinct from the review stage, deliberately ───────────────────────────
-- The obvious shortcut is a `hidden` review stage, and it conflates two
-- independent things. An idea can be `under_review` internally and perfectly
-- fine to show publicly, or `planned` and still deliberately withheld because
-- the plan is not announced yet. Folding them means an admin cannot publish
-- something without also declaring where it sits in triage, and cannot triage
-- it without republishing it.
--
-- ── Three states, not a boolean ────────────────────────────────────────────
-- `pending` and `hidden` are both invisible and they are not the same thing,
-- and the difference is the whole moderation queue. `pending` means nobody has
-- looked yet, so it belongs in a list of work; `hidden` means somebody looked
-- and said no, so it must NOT come back to that list. A boolean cannot tell a
-- rejected submission from an unreviewed one, and the queue would either keep
-- re-presenting rejects forever or lose the record of the decision.
--
-- A CHECK rather than an enum type, matching `idea_settings_portal_moderation_chk`
-- from 0008 and for the reason given there: altering a CHECK is an ordinary
-- migration, where extending an enum is not transactional in older Postgres and
-- cannot be reverted in the same one.
ALTER TABLE ideas
    ADD COLUMN portal_visibility text NOT NULL DEFAULT 'published';
--> statement-breakpoint

ALTER TABLE ideas
    ADD CONSTRAINT ideas_portal_visibility_chk
    CHECK (portal_visibility IN ('published', 'pending', 'hidden'));
--> statement-breakpoint

-- ── Why the default is `published` and not `pending` ───────────────────────
-- This looks like the unsafe direction on a public surface and is the opposite.
--
-- Every idea that exists today is an INTERNAL capture: `submitter_name` and
-- `submitter_email` have been on this table since v0.8.0 and have never been
-- written to, because nothing outside the workspace could reach it. Whichever
-- of those ideas sit in a published product at a published stage are ALREADY
-- public, right now, under the rules from 0008. Defaulting them to `published`
-- changes nothing for anyone; defaulting to `pending` would silently empty
-- every live portal on deploy and present its owner with a queue of their own
-- backlog to approve.
--
-- The new path is where the deliberate act belongs. A public submission arrives
-- through an endpoint that does not exist yet, and that endpoint sets `pending`
-- explicitly when the workspace is on review-first. Nothing inherits its way
-- into being published from outside.
--
-- Internal captures stay `published` by default even on a review-first
-- workspace, and that is not an oversight either: moderation is a gate on
-- strangers writing to your board, not on your own team capturing an idea. An
-- admin who wants one of their own hidden has the `hidden` state for it.
COMMENT ON COLUMN ideas.portal_visibility IS
    'Portal publication state, independent of the review stage: published, pending (awaiting moderation), or hidden (withheld by an admin). Defaults to published because every pre-existing idea is an internal capture already governed by the product/stage rules; the public submission endpoint sets pending explicitly under review-first moderation.';
--> statement-breakpoint

-- The moderation queue's only query: this workspace's unreviewed submissions.
-- Partial, because `pending` is the small and interesting set while
-- `published` is nearly the whole table, and an index over all three states
-- would be mostly a copy of `ideas_ws_idx`.
CREATE INDEX ideas_pending_moderation_idx ON ideas (workspace_id)
    WHERE portal_visibility = 'pending';
--> statement-breakpoint

-- ── Teaching the publication predicate about it ────────────────────────────
--
-- `specboards_portal_shows_idea` is the one place the database states what a
-- portal may show, and this is now part of that statement rather than an extra
-- condition remembered at each of the four call sites. Two of those sites are
-- on `idea_votes` (a vote must not be visible for an idea that is not), and
-- that is exactly the kind of second place a hand-added `AND` gets forgotten.
--
-- Which means a signature change, and Postgres tracks policy dependencies on
-- functions: `DROP FUNCTION` here fails with "cannot drop ... because other
-- objects depend on it", naming all four policies. Dropping them first is
-- therefore not tidiness, it is the only order that works. `apply_grants()`
-- recreates every one of them below, so nothing is left dropped.
--
-- `IF EXISTS` because on a FRESH database the role does not exist yet, 0009's
-- grants were skipped, and these policies were never created. That path has to
-- reach the same place as an existing database.
DROP POLICY IF EXISTS ideas_portal_select ON ideas;
--> statement-breakpoint
DROP POLICY IF EXISTS ideas_portal_clamp ON ideas;
--> statement-breakpoint
DROP POLICY IF EXISTS idea_votes_portal_select ON idea_votes;
--> statement-breakpoint
DROP POLICY IF EXISTS idea_votes_portal_clamp ON idea_votes;
--> statement-breakpoint

DROP FUNCTION IF EXISTS public.specboards_portal_shows_idea(uuid, uuid, text);
--> statement-breakpoint

-- Same as the 0009 version plus the visibility term. The NULL product handling
-- is unchanged and still load-bearing: an idea whose product was deleted has
-- `product_id` set to null (ON DELETE SET NULL, to preserve captured demand),
-- a null product is in no published set, and so such an idea is not published.
CREATE FUNCTION public.specboards_portal_shows_idea(
    target_workspace uuid,
    target_product uuid,
    target_status text,
    target_visibility text
) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT target_visibility = 'published'
     AND target_product IS NOT NULL
     AND public.specboards_portal_shows_product(target_workspace, target_product)
     AND EXISTS (
    SELECT 1 FROM idea_settings s
    WHERE s.workspace_id = target_workspace
      AND target_status = ANY (s.portal_idea_statuses)
  );
$$;
--> statement-breakpoint

-- Superseding 0011, which superseded 0010, which superseded 0009. Replaced
-- wholesale rather than patched, because `infra/portal-role.sql` calls this
-- same function on a fresh database and two copies of these grants is the drift
-- the function exists to prevent. Changed here: the four `shows_idea` call
-- sites take the visibility column. Everything else is unchanged, and the
-- earlier migrations carry the reasoning for each part.
CREATE OR REPLACE FUNCTION public.specboards_portal_apply_grants() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_portal') THEN
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA public TO specboards_portal;
    GRANT EXECUTE ON FUNCTION
        public.specboards_portal_published(uuid),
        public.specboards_portal_shows_product(uuid, uuid),
        public.specboards_portal_shows_idea(uuid, uuid, text, text),
        public.specboards_portal_shows_item(uuid, uuid, text),
        public.specboards_portal_shows_stage(uuid, text)
        TO specboards_portal;

    GRANT SELECT ON workspaces, idea_settings, idea_portal_products,
                    products, ideas, releases, features, idea_statuses
        TO specboards_portal;

    -- Column-level, and deliberately without `voter_email`. See 0010.
    REVOKE SELECT ON idea_votes FROM specboards_portal;
    GRANT SELECT (id, workspace_id, idea_id, created_at) ON idea_votes
        TO specboards_portal;

    DROP POLICY IF EXISTS workspaces_portal_select ON workspaces;
    CREATE POLICY workspaces_portal_select ON workspaces
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(id));

    DROP POLICY IF EXISTS idea_settings_portal_select ON idea_settings;
    CREATE POLICY idea_settings_portal_select ON idea_settings
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    DROP POLICY IF EXISTS idea_portal_products_portal_select ON idea_portal_products;
    CREATE POLICY idea_portal_products_portal_select ON idea_portal_products
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    DROP POLICY IF EXISTS products_portal_select ON products;
    CREATE POLICY products_portal_select ON products
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_product(workspace_id, id));

    DROP POLICY IF EXISTS ideas_portal_select ON ideas;
    CREATE POLICY ideas_portal_select ON ideas
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_idea(
            workspace_id, product_id, status, portal_visibility));

    DROP POLICY IF EXISTS idea_statuses_portal_select ON idea_statuses;
    CREATE POLICY idea_statuses_portal_select ON idea_statuses
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_stage(workspace_id, key));

    DROP POLICY IF EXISTS idea_votes_portal_select ON idea_votes;
    CREATE POLICY idea_votes_portal_select ON idea_votes
        FOR SELECT TO specboards_portal
        USING (EXISTS (
            SELECT 1 FROM ideas i
            WHERE i.id = idea_votes.idea_id
              AND public.specboards_portal_shows_idea(
                  i.workspace_id, i.product_id, i.status, i.portal_visibility)
        ));

    DROP POLICY IF EXISTS releases_portal_select ON releases;
    CREATE POLICY releases_portal_select ON releases
        FOR SELECT TO specboards_portal
        USING (
            public.specboards_portal_published(workspace_id)
            AND EXISTS (
                SELECT 1 FROM idea_settings s
                WHERE s.workspace_id = releases.workspace_id
                  AND s.portal_roadmap_enabled
            )
        );

    DROP POLICY IF EXISTS features_portal_select ON features;
    CREATE POLICY features_portal_select ON features
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_item(workspace_id, product_id, status));

    -- ── The RESTRICTIVE clamps ─────────────────────────────────────────────
    DROP POLICY IF EXISTS ideas_portal_clamp ON ideas;
    CREATE POLICY ideas_portal_clamp ON ideas
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_idea(
            workspace_id, product_id, status, portal_visibility));

    DROP POLICY IF EXISTS idea_statuses_portal_clamp ON idea_statuses;
    CREATE POLICY idea_statuses_portal_clamp ON idea_statuses
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_stage(workspace_id, key));

    DROP POLICY IF EXISTS products_portal_clamp ON products;
    CREATE POLICY products_portal_clamp ON products
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_product(workspace_id, id));

    DROP POLICY IF EXISTS workspaces_portal_clamp ON workspaces;
    CREATE POLICY workspaces_portal_clamp ON workspaces
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(id));

    DROP POLICY IF EXISTS idea_settings_portal_clamp ON idea_settings;
    CREATE POLICY idea_settings_portal_clamp ON idea_settings
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    DROP POLICY IF EXISTS idea_portal_products_portal_clamp ON idea_portal_products;
    CREATE POLICY idea_portal_products_portal_clamp ON idea_portal_products
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    DROP POLICY IF EXISTS features_portal_clamp ON features;
    CREATE POLICY features_portal_clamp ON features
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_item(workspace_id, product_id, status));

    DROP POLICY IF EXISTS releases_portal_clamp ON releases;
    CREATE POLICY releases_portal_clamp ON releases
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (
            public.specboards_portal_published(workspace_id)
            AND EXISTS (
                SELECT 1 FROM idea_settings s
                WHERE s.workspace_id = releases.workspace_id
                  AND s.portal_roadmap_enabled
            )
        );

    DROP POLICY IF EXISTS idea_votes_portal_clamp ON idea_votes;
    CREATE POLICY idea_votes_portal_clamp ON idea_votes
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (EXISTS (
            SELECT 1 FROM ideas i
            WHERE i.id = idea_votes.idea_id
              AND public.specboards_portal_shows_idea(
                  i.workspace_id, i.product_id, i.status, i.portal_visibility)
        ));
END;
$fn$;
--> statement-breakpoint

SELECT public.specboards_portal_apply_grants();
