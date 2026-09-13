-- Let the public roadmap know the SHAPE of a workflow, without its words.
--
-- The roadmap maps each published item onto a fixed public vocabulary (Planned
-- / In progress / Shipped) rather than showing the workspace's own stage name,
-- because those are routinely `blocked`, `in_review` or `waiting_on_legal` and
-- none of that belongs on a customer-facing page.
--
-- Doing that needs the workflow ORDER. There is no fixed set of keys to map
-- from, because the vocabulary is workspace-defined: one team's `done` is
-- another's `released` is another's `live`. What every workflow has is a
-- sequence, which is the same thing `terminalStatus` in core already relies on
-- ("a team renames the vocabulary in Settings and nothing records which of
-- their stages means the work is over. Position does.").
--
-- ── Why not derive it from `portal_roadmap_item_statuses` ──────────────────
-- Because that array is not in workflow order and cannot be relied on to be.
-- It is the admin's tick-list, and the settings UI appends a newly-ticked
-- status to the end, so an admin who publishes `done` and later adds
-- `in_progress` produces `['done','in_progress']`. Reading position out of it
-- would announce finished work as planned, which is the exact failure this is
-- meant to prevent, and it would do so only for workspaces that edited their
-- selection twice.
--
-- The grant is by column and deliberately omits `label`. See the note inside.

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

    -- `workspace_statuses` is granted BY COLUMN, and `label` is not in it.
    --
    -- The public roadmap needs the ORDER of a workspace's stages, and nothing
    -- else: it maps each item onto a fixed public vocabulary (Planned / In
    -- progress / Shipped) by where its stage sits in the workflow. It must
    -- never render the workspace's own name for a stage, because those are
    -- routinely things like `blocked` or `waiting_on_legal` and the whole point
    -- of the coarse grouping is not to publish them.
    --
    -- "The read model does not project it" is a property of code somebody can
    -- rewrite. Not granting the column is a property of the connection. Same
    -- reasoning as `idea_votes.voter_email` in 0010, and the same shape.
    REVOKE SELECT ON workspace_statuses FROM specboards_portal;
    GRANT SELECT (id, workspace_id, product_id, key, position) ON workspace_statuses
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

    -- Gated on the roadmap switch rather than merely on the portal being on,
    -- because the stage order is only ever needed to render the roadmap. A
    -- workspace running an ideas-only portal publishes nothing of its delivery
    -- workflow, not even its shape.
    DROP POLICY IF EXISTS workspace_statuses_portal_select ON workspace_statuses;
    CREATE POLICY workspace_statuses_portal_select ON workspace_statuses
        FOR SELECT TO specboards_portal
        USING (
            public.specboards_portal_published(workspace_id)
            AND EXISTS (
                SELECT 1 FROM idea_settings s
                WHERE s.workspace_id = workspace_statuses.workspace_id
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

    DROP POLICY IF EXISTS workspace_statuses_portal_clamp ON workspace_statuses;
    CREATE POLICY workspace_statuses_portal_clamp ON workspace_statuses
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (
            public.specboards_portal_published(workspace_id)
            AND EXISTS (
                SELECT 1 FROM idea_settings s
                WHERE s.workspace_id = workspace_statuses.workspace_id
                  AND s.portal_roadmap_enabled
            )
        );

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
