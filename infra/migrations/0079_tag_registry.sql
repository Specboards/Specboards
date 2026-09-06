-- The workspace's tag registry.
--
-- Tags were free text and nothing else. `features.tags` is a `text[]`, the
-- editor was a single comma-separated input, and the write path split on commas
-- and stored whatever came out. So `area:web`, `Area:Web` and `area:web ` were
-- three distinct tags: three chips on a card, three entries in the filter menu,
-- three separate filters, and nothing anywhere to suggest the third was a typo.
-- The conventions this workspace runs on (`area:*`, `tier-*`, `on-prem`) were
-- held together by people retyping them correctly.
--
-- ── Why a table and not a CHECK or an enum ──────────────────────────────────
-- The vocabulary has to be editable by admins at runtime and extensible by
-- anyone from a card, which rules out both. A row per tag also gives renaming
-- somewhere to happen: renaming a value that exists only inside a thousand
-- arrays is a data migration, renaming a row is an UPDATE.
--
-- ── Why item values stay in features.tags ───────────────────────────────────
-- The obvious shape is a join table and a foreign key, which would make a
-- dangling tag impossible. It is deliberately not that, for the same reason
-- `features.custom_fields` stores property values by key rather than by row:
-- deleting a definition then *hides* values instead of destroying them, and
-- re-adding it brings them back. An admin tidying a settings list must not
-- silently delete other people's work, and with a foreign key and a cascade
-- that is exactly what a stray Delete would do. The cost is that
-- `features.tags` can hold a name the registry no longer lists, which is
-- expected rather than corrupt, and reads treat it that way.
--
-- ── Why workspace-wide and not per product ─────────────────────────────────
-- `workspace_properties` is per product with NULL meaning the workspace
-- default, and the symmetry is tempting. Tags are not properties: they cross
-- products by nature (`area:web` means the same thing wherever it is used), and
-- per-product registries would weaken the single guarantee this table exists to
-- give, because two products could each define their own `area:web` and we
-- would be back to two spellings of one tag. If a product ever does need its
-- own vocabulary, adding a nullable `product_id` where NULL is the workspace
-- default is a pure addition and needs no rewrite of what is here.
CREATE TABLE "workspace_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- The canonical display name, and the value written into `features.tags`.
  -- Casing is preserved: matching is case-insensitive (see the index below),
  -- but which spelling a workspace shows is a choice its members made.
  "name" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "workspace_tags_ws_idx" ON "workspace_tags" ("workspace_id");--> statement-breakpoint

-- Case-insensitive uniqueness, which is the whole point: `Area:Web` must not be
-- insertable beside `area:web`. A functional index rather than a constraint
-- because a UNIQUE constraint cannot be built on an expression, and `lower()`
-- rather than `citext` to avoid an extension on a managed cluster.
--
-- `lower()` is not `initcap`-aware or locale-sensitive here, and the
-- application's `tagKey` uses `toLowerCase()` for exactly that reason: a
-- locale-sensitive fold in one of the two would let the app and Postgres
-- disagree about whether two names collide, which surfaces as an insert the app
-- believed was safe failing on the constraint.
CREATE UNIQUE INDEX "workspace_tags_ws_name_idx"
  ON "workspace_tags" ("workspace_id", lower("name"));--> statement-breakpoint

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Seed the registry from the tags workspaces are already using, so nobody
-- opens Settings after this deploy and finds an empty list beside cards covered
-- in tags.
--
-- Deliberately INSERT-only. The tempting second half is an UPDATE over
-- `features.tags` folding every near-duplicate onto its canonical spelling, and
-- that is not done here: it is an irreversible rewrite of user data, it merges
-- tags that may have been meant as distinct, and it would run unattended inside
-- a release command where nobody is watching. Existing item values keep the
-- casing they have. They still match the registry, because every read compares
-- case-insensitively, and they converge on the canonical spelling the next time
-- each item is saved. A gradual, visible, per-item merge instead of one silent
-- global one.
--
-- Grouping on lower(btrim(tag)) is what collapses the near-duplicates: every
-- spelling of one tag lands in one group, and the group keeps the spelling the
-- oldest item used, because whoever first used a tag chose how the workspace
-- spells it. Empty and whitespace-only entries are dropped, which is what a
-- trailing comma in the old editor produced.
--
-- Written as GROUP BY with an ordered array_agg rather than DISTINCT ON with a
-- window function. The two are equivalent here and this one can be read without
-- knowing where window evaluation sits relative to DISTINCT, which is the sort
-- of thing that should not be load-bearing in a statement that runs unattended
-- inside a release command.
INSERT INTO "workspace_tags" ("workspace_id", "name", "position")
SELECT workspace_id,
       name,
       (row_number() OVER (
          PARTITION BY workspace_id ORDER BY first_used, name
        ) - 1)::int
FROM (
  SELECT f."workspace_id" AS workspace_id,
         (array_agg(btrim(u.tag) ORDER BY f."created_at", f."id"))[1] AS name,
         min(f."created_at") AS first_used
  FROM "features" f
  CROSS JOIN LATERAL unnest(f."tags") AS u(tag)
  WHERE btrim(u.tag) <> ''
  GROUP BY f."workspace_id", lower(btrim(u.tag))
) seed;--> statement-breakpoint

-- ── Access ──────────────────────────────────────────────────────────────────
-- Readable by any member, because every card renders tags and the filter menus
-- list them.
--
-- Writable by any member too, which is the one place this differs from
-- `workspace_properties` (admin-only). Creating a tag from a card when it does
-- not exist yet is a stated requirement of the feature, and an editor who can
-- already put arbitrary text in `features.tags` gains nothing by also being
-- able to add the row that names it. Rename and delete are the destructive
-- operations and are gated in the service layer to org admins; they are not
-- separated here because RLS cannot distinguish an INSERT from an UPDATE within
-- one FOR ALL policy without a second policy per command, and the two policies
-- below say exactly that.
ALTER TABLE "workspace_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY workspace_tags_read ON "workspace_tags"
  FOR SELECT USING (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_tags_append ON "workspace_tags"
  FOR INSERT WITH CHECK (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_tags_amend ON "workspace_tags"
  FOR UPDATE USING (specboards_is_org_admin("workspace_id"))
  WITH CHECK (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

CREATE POLICY workspace_tags_remove ON "workspace_tags"
  FOR DELETE USING (specboards_is_org_admin("workspace_id"));--> statement-breakpoint

-- Table privileges for the app connection. `infra/rls-role.sql` sets ALTER
-- DEFAULT PRIVILEGES so new tables are reachable automatically, but the live
-- test and prod clusters predate that script and use a `writer` group role with
-- per-table grants instead: without this the table is invisible to
-- specboards_app on exactly the two databases that matter. Same guarded shape
-- as 0067, 0068 and 0074; see the note in 0067 for what the failure looks like.
--
-- Granted to specboards_worker as well, unlike the model tables: spec import
-- writes tags from frontmatter on a background path, so the worker does need to
-- read the registry and add to it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_tags" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_worker') THEN
    GRANT SELECT, INSERT ON "workspace_tags" TO specboards_worker;
  END IF;
END $$;
