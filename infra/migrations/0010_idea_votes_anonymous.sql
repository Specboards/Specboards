-- Let a stranger vote: anonymous rows in `idea_votes`.
--
-- The table has been members-only by construction since it was added. Not by
-- policy, which could be widened, but by its column types:
--
--     user_id uuid NOT NULL,
--     CONSTRAINT idea_votes_idea_user_uq UNIQUE (idea_id, user_id)
--
-- A portal visitor has no user id, so there is no row they could be. Nothing
-- in the public voting path can be built until that is false.
--
-- ── The identity is a verified email, stored in the clear ──────────────────
-- Decided deliberately, because the card asked for the reasoning to be written
-- down here rather than in a commit message.
--
-- Voting on the portal is confirmed by an emailed magic link, and the reason
-- that design was chosen over a cookie or a captcha was that it yields a
-- contactable voter list: the people who asked for a thing can be told when it
-- ships. A hash satisfies the uniqueness rule and the "has this person voted"
-- question equally well, and destroys exactly the property the mail round trip
-- was paid for. It is also not a decision that can be revisited later, because
-- the addresses a hash discards are not recoverable.
--
-- The cost is real and is not waved away: verified customer email addresses now
-- live in a table on the write path of a public endpoint. Three things bound
-- it, and the third is the one that matters most.
--
--   1. The endpoint only ever writes an address it has just proved someone
--      controls, so the column cannot be used as a dumping ground for a list
--      somebody else supplied.
--   2. `voter_email` is projected by no read model. The public views count
--      rows; they never select this column.
--   3. The portal's database role cannot read it AT ALL. See the grant change
--      at the bottom of this file: `specboards_portal` drops its table-wide
--      SELECT on `idea_votes` for a column-level grant that omits this column.
--      Point 2 is a property of code that could be rewritten wrongly; point 3
--      is a property of the connection, and it fails closed.
ALTER TABLE idea_votes
    ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE idea_votes
    ADD COLUMN voter_email text;
--> statement-breakpoint

COMMENT ON COLUMN idea_votes.voter_email IS
    'Verified email of an external portal voter; null for member votes. Stored in the clear so voters can be told when their idea ships, which is why magic-link voting was chosen. Never projected by a public read model, and unreadable by the specboards_portal role (column-level grant).';
--> statement-breakpoint

-- Exactly one identity per row, never both and never neither.
--
-- Without this a row with two identities counts once but matches both unique
-- indexes below, and a row with neither is an unattributable vote that every
-- index lets through as often as it is inserted. `<>` on two booleans is XOR,
-- which is the whole rule in one expression.
ALTER TABLE idea_votes
    ADD CONSTRAINT idea_votes_one_identity_chk
    CHECK ((user_id IS NOT NULL) <> (voter_email IS NOT NULL));
--> statement-breakpoint

-- ── Uniqueness: two partial indexes, not one nullable index ────────────────
--
-- The obvious move once `user_id` is nullable is to leave the existing unique
-- constraint alone and add `voter_email` beside it. That silently stops
-- enforcing anything for external voters: in Postgres two NULLs do not conflict
-- (the default `NULLS DISTINCT`), so every anonymous vote satisfies
-- `UNIQUE (idea_id, user_id)` no matter how many there already are, and the
-- table would accept unlimited duplicate votes while looking constrained.
--
-- `UNIQUE NULLS NOT DISTINCT` (PG15+) fixes the counting but merges the two
-- identity kinds into one key, so a member and an external voter with a row on
-- the same idea would collide on a column neither of them populates.
--
-- One partial index per identity kind keeps them independent: a member votes
-- once, an external voter votes once, and the two never see each other.
ALTER TABLE idea_votes
    DROP CONSTRAINT idea_votes_idea_user_uq;
--> statement-breakpoint

CREATE UNIQUE INDEX idea_votes_idea_user_uq ON idea_votes (idea_id, user_id)
    WHERE user_id IS NOT NULL;
--> statement-breakpoint

-- Indexed on `lower(voter_email)` rather than the raw column. The intake
-- normalises before writing, so this should never be what stops a duplicate;
-- it is here because the alternative to a case-insensitive key is that
-- `Ada@example.com` and `ada@example.com` are two voters, and the only thing
-- preventing that would be one `.toLowerCase()` in application code.
--
-- Note that the app's ON CONFLICT clauses must now name these predicates.
-- `ON CONFLICT (idea_id, user_id)` does not match a partial index unless the
-- statement restates its WHERE, and Postgres raises rather than falling back to
-- an unconstrained insert. `db/ideas.ts` passes `targetWhere` for this reason.
CREATE UNIQUE INDEX idea_votes_idea_email_uq ON idea_votes (idea_id, lower(voter_email))
    WHERE voter_email IS NOT NULL;
--> statement-breakpoint

-- ── The portal role must not be able to read the addresses ─────────────────
--
-- 0009 granted `SELECT ON idea_votes` to `specboards_portal` so the public
-- views can count votes, and at the time every column on the table was an id or
-- a timestamp. That is no longer true, and a grant is table-wide: the
-- RESTRICTIVE clamps added in 0009 bound which ROWS this role sees, and say
-- nothing about which columns. As written, one `select *` in a future read
-- model publishes a verified customer email list to the internet.
--
-- Column-level SELECT closes it at the connection instead. The portal keeps
-- exactly what a count needs and `voter_email` is not a column it can name;
-- reaching for it fails with a permission error rather than returning data.
--
-- Replacing the whole function rather than issuing the grants inline, because
-- `infra/portal-role.sql` calls this same function on a fresh database where
-- the migration's own grants were skipped for want of a role. Two copies of
-- these grants is the drift this function exists to prevent, so the definition
-- stays in one place and this migration supersedes it. Everything except the
-- `idea_votes` grant is unchanged from 0009, which carries the reasoning for
-- each policy in full.
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
        public.specboards_portal_shows_item(uuid, uuid, text)
        TO specboards_portal;

    GRANT SELECT ON workspaces, idea_settings, idea_portal_products,
                    products, ideas, releases, features
        TO specboards_portal;

    -- `idea_votes` is the exception, and the exception is the point.
    --
    -- REVOKE first: on an existing database 0009 already granted the whole
    -- table, and a column-level GRANT does not narrow a table-level one. Adding
    -- the columns without revoking would leave the broad grant in place and
    -- this whole change would be decorative. Harmless on a fresh database,
    -- where there is nothing to revoke.
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
-- the early return and infra/portal-role.sql does the work.
SELECT public.specboards_portal_apply_grants();
