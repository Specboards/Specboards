-- Let the portal read the labels of the stages it publishes.
--
-- `ideas.status` holds a stage KEY (`under_review`), and the human label lives
-- in `idea_statuses`, which the portal role was never granted. The public ideas
-- list needs a status filter, and a filter reading "under_review" is the
-- schema's internal slug leaking onto a customer's branded page.
--
-- ── Why not resolve the label in application code ──────────────────────────
-- Because it is only correct for workspaces that have never customised their
-- workflow. `resolveIdeaStages` falls back to `DEFAULT_IDEA_STAGES` when a
-- workspace has fewer than two rows here, so the built-in keys exist only in
-- code and the fallback covers them. A workspace that HAS defined its own
-- stages has rows and no code-side labels at all, and those are exactly the
-- workspaces most likely to have thought about what their portal says.
--
-- ── The published subset, not the whole workflow ───────────────────────────
-- An admin chooses which stages appear publicly (`portal_idea_statuses`, 0008),
-- and the stages they did NOT choose are as much internal business as an
-- unpublished product's name: "Awaiting legal" or "Blocked on the Acme deal"
-- is a stage nobody meant to publish. So this is gated on membership of that
-- array rather than on the portal merely being on, which is the same shape as
-- `specboards_portal_shows_product` and for the same reason.
--
-- Note what this does NOT gate on: whether any published idea currently sits at
-- the stage. A filter should offer a published stage that happens to be empty,
-- and hiding it would make the filter's contents a side channel for how the
-- workspace's triage is going.
CREATE OR REPLACE FUNCTION public.specboards_portal_shows_stage(target_workspace uuid, target_status text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.specboards_portal_published(target_workspace)
     AND EXISTS (
    SELECT 1 FROM idea_settings s
    WHERE s.workspace_id = target_workspace
      AND target_status = ANY (s.portal_idea_statuses)
  );
$$;
--> statement-breakpoint

-- Superseding 0010's definition, which superseded 0009's. Replaced wholesale
-- rather than granting inline, because `infra/portal-role.sql` calls this same
-- function on a fresh database where the migration's own grants were skipped
-- for want of a role, and two copies of these grants is the drift the function
-- exists to prevent. Everything except the `idea_statuses` grant and its two
-- policies is unchanged; 0009 carries the reasoning for each of the others in
-- full, and 0010 for the column-level `idea_votes` grant.
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
        public.specboards_portal_shows_idea(uuid, uuid, text),
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
        USING (public.specboards_portal_shows_idea(workspace_id, product_id, status));

    -- Only the stages this workspace publishes. An unpublished stage's LABEL is
    -- the thing being protected, the same way an unpublished product's name is.
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
              AND public.specboards_portal_shows_idea(i.workspace_id, i.product_id, i.status)
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
    -- These AND with the permissive result rather than ORing, so they bound
    -- this role no matter what any other policy grants. 0009 explains why that
    -- matters here and nowhere else.
    DROP POLICY IF EXISTS ideas_portal_clamp ON ideas;
    CREATE POLICY ideas_portal_clamp ON ideas
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_idea(workspace_id, product_id, status));

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
              AND public.specboards_portal_shows_idea(i.workspace_id, i.product_id, i.status)
        ));
END;
$fn$;
--> statement-breakpoint

SELECT public.specboards_portal_apply_grants();
