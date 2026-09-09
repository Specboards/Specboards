-- Give the public Ideas portal a reader the database can reason about.
--
-- Migration 0008 added the visibility model: which products, which stages,
-- whether the roadmap is included. It deliberately added no way to read any of
-- it. Every ideas table is under RLS with a single membership-scoped policy
-- (`ideas_member_all` and friends, keyed on `specboards_is_member`), and a
-- portal visitor is not a member, so on the tenant role the public path sees
-- zero rows no matter what those columns say.
--
-- ── Why not just read on the owner connection ──────────────────────────────
-- Because `lib/db.ts` already says what that costs, about a surface with far
-- more supervision than this one: "on every path that resolves getDb(), tenant
-- isolation is whatever the query says it is. The workspaceId predicate in the
-- service layer is not a belt beside the braces of a policy; it IS the
-- enforcement, and a query that omits it reads every tenant's rows."
--
-- That is the wrong bargain on the only endpoint with no authenticated reader
-- to notice a leak, where the blast radius of one wrong WHERE clause is an
-- unannounced product's backlog on a public URL, and where nobody who could
-- report it is looking.
--
-- ── The shape ──────────────────────────────────────────────────────────────
-- A dedicated non-owner role, `specboards_portal`, with role-targeted policies
-- expressing publication. This is `specboards_worker` again (infra/worker-role.sql):
-- a role-targeted policy is evaluated only when the connected role IS that
-- role, so none of this loosens anything for `specboards_app`.
--
-- The one difference from the worker is the predicate. The worker's policies
-- are `USING (true)`, because its bound is its grants. These are not: they
-- carry the publication rule itself, so the database refuses an unpublished
-- product, an unpublished stage, or a disabled portal even when every filter in
-- the application is wrong. That second, independent statement of the rules is
-- the entire reason for choosing this over the owner connection.
--
-- ── No session variable, and why that is a simplification ──────────────────
-- The `specboards_app` policies key on `app.user_id`, which is why every query
-- on that connection has to be wrapped in `asUser()` (db-scope.ts) or the
-- policies match nothing. The predicate here is purely data-driven, so there is
-- no equivalent helper to forget, and no failure mode where the portal silently
-- reads nothing because a wrapper was missed.
--
-- It follows that this role can read the published rows of EVERY workspace, not
-- just the one whose subdomain was requested. That is deliberate. RLS's job
-- here is publication; deciding which portal a request is for is the
-- application's job, and the two failure modes are not comparable. A bug in the
-- host-to-workspace resolution shows one public portal's content under another
-- public portal's URL: wrong, visible, and reportable by anyone. A bug on the
-- owner connection publishes an unpublished internal backlog.
--
-- ── This migration is inert until the role exists ──────────────────────────
-- The grants and policies are guarded on the role being present, the same way
-- the worker grants in 0003 are. `infra/portal-role.sql` creates it, by hand,
-- once per database, because role creation needs CREATEROLE and the login
-- password must not land in git. So this can merge and deploy ahead of that
-- step; the portal simply has no reader until it is done.
--
-- Which raises the ordering problem that has bitten this repo before. On a
-- FRESH database the migration runs first, finds no role, and skips; the
-- operator then creates the role and the policies still do not exist. On an
-- EXISTING database the role is already there and the migration applies them.
-- Two paths, two outcomes, and the discrepancy is invisible until a portal
-- returns nothing. `infra/worker-role.sql` records exactly this happening to
-- `workspace_tags`: "the omission was only reachable on a fresh install, where
-- the migration's own grant is skipped because the role does not exist yet."
--
-- So the grants and policies live in a function, called from both here and
-- from the provisioning script, rather than being copied into both and
-- drifting. It is idempotent (DROP POLICY IF EXISTS before each CREATE), so
-- whichever runs second is a no-op, and re-running the provisioning script
-- stays safe as its own header promises.

-- ── Publication predicates ─────────────────────────────────────────────────
-- SECURITY DEFINER for the same reason `specboards_is_member` is: evaluating
-- these means reading `idea_settings` and `idea_portal_products`, which are
-- themselves policied, and a policy that triggers policy evaluation on another
-- table the same role is being gated on is how you get infinite recursion.
-- Running as the owner reads the configuration directly and settles it.
--
-- `search_path` is pinned on each, which the baseline generator explicitly
-- checks for: an unpinned SECURITY DEFINER function is a privilege-escalation
-- primitive, and six of them were lost once already when this file's ancestor
-- was first generated.

-- Is this workspace's portal switched on at all? The outermost gate: false
-- here makes everything below unreadable regardless of any other setting.
CREATE OR REPLACE FUNCTION public.specboards_portal_published(target_workspace uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM idea_settings s
    WHERE s.workspace_id = target_workspace
      AND s.portal_enabled
  );
$$;
--> statement-breakpoint

-- Is this product one the workspace publishes? A product with no row in
-- idea_portal_products is not published, so the empty default publishes
-- nothing.
CREATE OR REPLACE FUNCTION public.specboards_portal_shows_product(target_workspace uuid, target_product uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.specboards_portal_published(target_workspace)
     AND EXISTS (
    SELECT 1 FROM idea_portal_products p
    WHERE p.workspace_id = target_workspace
      AND p.product_id = target_product
  );
$$;
--> statement-breakpoint

-- Is this idea's review stage one the workspace publishes?
--
-- NULL product is handled by the caller, not here: an idea whose product was
-- deleted has `product_id` set to null (ON DELETE SET NULL, to preserve
-- captured demand), and a null product is in no published set, so such an idea
-- is not published. That is the correct answer and it is easy to lose by
-- writing the join the other way round.
CREATE OR REPLACE FUNCTION public.specboards_portal_shows_idea(target_workspace uuid, target_product uuid, target_status text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT target_product IS NOT NULL
     AND public.specboards_portal_shows_product(target_workspace, target_product)
     AND EXISTS (
    SELECT 1 FROM idea_settings s
    WHERE s.workspace_id = target_workspace
      AND target_status = ANY (s.portal_idea_statuses)
  );
$$;
--> statement-breakpoint

-- Is this item fit for the public roadmap? Gated on its own switch as well as
-- the portal's: wanting feedback in the open is not the same decision as
-- publishing what you plan to build and when.
CREATE OR REPLACE FUNCTION public.specboards_portal_shows_item(target_workspace uuid, target_product uuid, target_status text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT target_product IS NOT NULL
     AND public.specboards_portal_shows_product(target_workspace, target_product)
     AND EXISTS (
    SELECT 1 FROM idea_settings s
    WHERE s.workspace_id = target_workspace
      AND s.portal_roadmap_enabled
      AND target_status = ANY (s.portal_roadmap_item_statuses)
  );
$$;
--> statement-breakpoint

-- ── Grants and policies, only if the role has been provisioned ─────────────
--
-- SELECT only, everywhere, and no exceptions. A public submission and a public
-- vote are writes, and they go through their own intake path with their own
-- quotas and their own validation. This role exists to read published rows; it
-- must not be able to change one, and a grant is a much harder thing to get
-- wrong than a policy.
CREATE OR REPLACE FUNCTION public.specboards_portal_apply_grants() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $fn$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_portal') THEN
        -- Nothing to grant to. infra/portal-role.sql calls this again once it
        -- has created the role, so a fresh database converges on the same
        -- state as an existing one.
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA public TO specboards_portal;
    GRANT EXECUTE ON FUNCTION
        public.specboards_portal_published(uuid),
        public.specboards_portal_shows_product(uuid, uuid),
        public.specboards_portal_shows_idea(uuid, uuid, text),
        public.specboards_portal_shows_item(uuid, uuid, text)
        TO specboards_portal;

    GRANT SELECT ON workspaces, idea_settings, idea_portal_products,
                    products, ideas, idea_votes, releases, features
        TO specboards_portal;

    -- The workspace behind the subdomain, and the fallback portal heading.
    -- Readable only while its portal is published, so an unpublished slug
    -- is not even confirmable as a workspace through this connection.
    DROP POLICY IF EXISTS workspaces_portal_select ON workspaces;
    CREATE POLICY workspaces_portal_select ON workspaces
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(id));

    -- The settings are the predicate's own source, and the portal renders
    -- the title from them.
    DROP POLICY IF EXISTS idea_settings_portal_select ON idea_settings;
    CREATE POLICY idea_settings_portal_select ON idea_settings
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    DROP POLICY IF EXISTS idea_portal_products_portal_select ON idea_portal_products;
    CREATE POLICY idea_portal_products_portal_select ON idea_portal_products
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_published(workspace_id));

    -- Only the published products. An unannounced product's NAME is the
    -- thing being protected here, which is why this is gated on the
    -- published set and not merely on the portal being on.
    DROP POLICY IF EXISTS products_portal_select ON products;
    CREATE POLICY products_portal_select ON products
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_product(workspace_id, id));

    DROP POLICY IF EXISTS ideas_portal_select ON ideas;
    CREATE POLICY ideas_portal_select ON ideas
        FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_idea(workspace_id, product_id, status));

    -- Votes back the public counts. Visible only for an idea that is itself
    -- published, so a count can never reveal an idea the portal does not
    -- show. The voter identity on these rows is not the portal's business
    -- and the read model does not project it.
    DROP POLICY IF EXISTS idea_votes_portal_select ON idea_votes;
    CREATE POLICY idea_votes_portal_select ON idea_votes
        FOR SELECT TO specboards_portal
        USING (EXISTS (
            SELECT 1 FROM ideas i
            WHERE i.id = idea_votes.idea_id
              AND public.specboards_portal_shows_idea(i.workspace_id, i.product_id, i.status)
        ));

    -- Releases are the roadmap's columns, so they follow the roadmap
    -- switch rather than the portal switch.
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

    -- ── The clamp ──────────────────────────────────────────────────────────
    --
    -- Everything above is PERMISSIVE, and permissive policies OR together. The
    -- membership policies these tables already carry (`ideas_member_all` and
    -- friends) are `TO public`, which includes this role, so what the portal
    -- role may read is really `specboards_is_member(...) OR <published>`.
    --
    -- That reads as harmless because `specboards_is_member` returns false with
    -- no `app.user_id`, and nothing sets one on this connection: `getPortalDb()`
    -- has no `asUser()` equivalent precisely because the predicates are
    -- data-driven. Verified: `select specboards_is_member(...)` is false there.
    --
    -- But "harmless as long as a session variable is never set" is a property of
    -- today's call sites, not of the database, and it fails open rather than
    -- closed. One `set_config('app.user_id', ...)` reaching this connection --
    -- a shared helper, a pooled connection, a future portal feature that wants
    -- to know who is signed in -- would hand the anonymous reader every row in
    -- any workspace that user belongs to, silently.
    --
    -- RESTRICTIVE policies AND with the permissive result instead of ORing, so
    -- these bound the portal role to published rows no matter what any other
    -- policy grants. They are `TO specboards_portal`, so they constrain nothing
    -- else. Belt and braces on the one connection that has no user to blame.
    --
    -- FOR SELECT, not FOR ALL, and that is deliberate rather than an oversight.
    -- The write dimension is already closed by the grants: this role holds
    -- SELECT and nothing else, which is a blunter and more reliable bound than
    -- any policy (`portal-role.sql`, and asserted by "cannot write anything at
    -- all"). Writing these FOR ALL bought nothing on top of that and did cost
    -- something real: `workspaces` carries an invariant that every write-capable
    -- policy on it belongs to the worker role, guarding a bug where an org owner
    -- could rename their own workspace through the tenant connection. A FOR ALL
    -- clamp trips it, and relaxing that guard to admit a policy which cannot
    -- grant a write anyway would trade a live protection for a redundant one.
    DROP POLICY IF EXISTS ideas_portal_clamp ON ideas;
    CREATE POLICY ideas_portal_clamp ON ideas
        AS RESTRICTIVE FOR SELECT TO specboards_portal
        USING (public.specboards_portal_shows_idea(workspace_id, product_id, status));

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

-- Apply now, for a database whose role already exists. On a fresh one this is
-- the no-op above and infra/portal-role.sql does the work.
SELECT public.specboards_portal_apply_grants();
