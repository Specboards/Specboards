-- Give Cards settings a product-scoped home, starting with transitions.
--
-- Settings > Cards has always described one workspace. A workspace with more
-- than one product has one set of stages, one transition mode, one set of
-- properties for all of them, which is wrong the moment two products work
-- differently. This is the first slice of moving those settings to the product,
-- and it carries the whole path (table, RLS, store, resolution, route, UI) on
-- the cheapest setting so the five that follow are the same shape repeated.
--
-- Shape: one row per (workspace, product), plus one row per workspace with
-- `product_id IS NULL` holding the workspace-wide default. Keeping the default
-- in this table rather than back on `workspaces` means there is exactly one
-- place a Cards setting lives, and resolution is a single query that reads at
-- most two rows. A NULL column value means "inherit", which is distinct from a
-- missing row and is how a product reverts to the default without deleting the
-- row that will soon carry five other settings.
--
-- `workspaces.transition_mode` is backfilled from here on and then goes unread.
-- It is deliberately NOT dropped in this migration: migrations run in the Fly
-- release_command before the new image takes traffic, so dropping a column the
-- currently-serving version still reads would break every Cards page and
-- /api/v1/statuses call for the length of the release, and again on any
-- rollback. A follow-up migration drops it (and the now-vestigial
-- `workspaces_admin_update` policy from 0062) once this code is confirmed on
-- production.

CREATE TABLE "product_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- NULL = the workspace-wide default row that products fall back to.
  "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE,
  -- NULL = inherit. Only meaningful on a product row; the default row is the
  -- bottom of the chain and is kept non-null by the store.
  "transition_mode" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "product_settings_transition_mode_check"
    CHECK ("transition_mode" IS NULL OR "transition_mode" IN ('strict', 'flexible')),
  -- A product row must name a product in its own workspace, so a tenant cannot
  -- be given a settings row pointing at someone else's product.
  CONSTRAINT "product_settings_product_ws_fk"
    FOREIGN KEY ("product_id", "workspace_id")
    REFERENCES "products"("id", "workspace_id") ON DELETE CASCADE
);--> statement-breakpoint

-- Two partial uniques rather than one, because NULL is never equal to NULL in a
-- plain unique index: without the second one a workspace could accumulate any
-- number of "default" rows and resolution would pick one at random.
CREATE UNIQUE INDEX "product_settings_product_uq"
  ON "product_settings" ("workspace_id", "product_id")
  WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_settings_default_uq"
  ON "product_settings" ("workspace_id")
  WHERE "product_id" IS NULL;--> statement-breakpoint

-- Carry every workspace's current setting across as its default row, so no
-- workspace changes behaviour when this deploys. Workspaces with no products
-- get one too: the row is the workspace default, not a product's.
INSERT INTO "product_settings" ("workspace_id", "product_id", "transition_mode")
SELECT w."id", NULL, w."transition_mode" FROM "workspaces" w;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- RLS. Reads follow product visibility; writes are the product-admin widening
-- this epic decided on. The workspace default row keeps the owner-only
-- predicate it had as a `workspaces` column, since it governs every product
-- that has not overridden it.
--
-- `specboards_can_manage_product` already returns true for an org admin, so a
-- workspace owner can write any product's row without a second branch.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "product_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY product_settings_read ON "product_settings"
  FOR SELECT USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_member("workspace_id")
      ELSE specboards_can_read_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint

CREATE POLICY product_settings_write ON "product_settings"
  FOR ALL USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_org_admin("workspace_id")
      ELSE specboards_can_manage_product("workspace_id", "product_id")
    END
  )
  WITH CHECK (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_org_admin("workspace_id")
      ELSE specboards_can_manage_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint

-- Table privileges for the app connection. `infra/rls-role.sql` sets ALTER
-- DEFAULT PRIVILEGES so a new table is reachable automatically, but the live
-- test and prod clusters predate that script and instead use a `writer` group
-- role with per-table grants (see that file's section 2). A new table is
-- therefore invisible to `specboards_app` on exactly the two databases that
-- matter, and the failure mode is the one #257 cost us: the statement runs,
-- the privilege check fails, and ingestion or a save dies with aclcheck_error.
-- Granting both, guarded on existence, costs nothing and closes it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "product_settings" TO writer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'specboards_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "product_settings" TO specboards_app;
  END IF;
END $$;
