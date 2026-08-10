-- Move the rest of Settings > Cards to the product, following the path
-- migration 0064 proved on transitions.
--
-- Four tables gain a nullable `product_id` where NULL means "the workspace
-- default every product inherits", exactly as `product_settings` already works:
--
--   workspace_statuses      the board's stages
--   workspace_stage_gates   the checklists guarding those stages
--   workspace_properties    admin-defined custom fields
--   detail_templates        reusable Markdown skeletons
--
-- and two settings that cannot take a `product_id` move into `product_settings`
-- instead. Built-in field visibility and the per-level default template live as
-- columns on `workspace_levels`, one row per level. Levels stay workspace-wide
-- (they are Settings > Hierarchy, not a Cards setting, and per-product levels
-- would break rollup, portfolio releases, and the `level` key `whoami`
-- publishes), so there is no row to hang a product's override on. They become
-- level-keyed maps on the product's settings row instead: `{levelKey: value}`,
-- where an absent key inherits that level and a present key overrides it.
--
-- An absent key rather than a null column is what makes adding a level safe. A
-- new level appears in nobody's map, so every product inherits the workspace
-- default for it, which for a fresh level is "all fields available". Adding a
-- level workspace-wide therefore cannot silently narrow a product that had
-- customised some other level.
--
-- RLS tightens as it re-scopes, and this is a real change rather than a
-- translation. Every one of these tables carries a single
-- `..._member_all` policy: `specboards_is_member(workspace_id)` FOR ALL. Any
-- member of the workspace can write the board's stages as far as Postgres is
-- concerned, and the only thing that has stopped them is `authorizeOrgAdmin` at
-- the route. That is the same shape as the gap #256 came from, with the
-- polarity reversed: there the database was stricter than the app and writes
-- vanished; here it is looser and the app is the only guard. Reads stay open to
-- anyone who can read the product; writes now require managing it.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. product_id on the four tables.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspace_statuses"
  ADD COLUMN "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_stage_gates"
  ADD COLUMN "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_properties"
  ADD COLUMN "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "detail_templates"
  ADD COLUMN "product_id" uuid REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint

-- A product row must name a product in its own workspace, so a tenant cannot be
-- handed a settings row pointing at someone else's product.
ALTER TABLE "workspace_statuses" ADD CONSTRAINT "workspace_statuses_product_ws_fk"
  FOREIGN KEY ("product_id", "workspace_id")
  REFERENCES "products"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_stage_gates" ADD CONSTRAINT "workspace_stage_gates_product_ws_fk"
  FOREIGN KEY ("product_id", "workspace_id")
  REFERENCES "products"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_properties" ADD CONSTRAINT "workspace_properties_product_ws_fk"
  FOREIGN KEY ("product_id", "workspace_id")
  REFERENCES "products"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "detail_templates" ADD CONSTRAINT "detail_templates_product_ws_fk"
  FOREIGN KEY ("product_id", "workspace_id")
  REFERENCES "products"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Uniqueness, in pairs. NULL is never equal to NULL in a plain unique
--    index, so a single constraint spanning a nullable product_id would let a
--    workspace accumulate any number of identically-keyed default rows. Each
--    old constraint becomes two partial indexes: one for product rows, one for
--    the default row.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "workspace_statuses" DROP CONSTRAINT "workspace_statuses_ws_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_statuses_product_key_uq"
  ON "workspace_statuses" ("workspace_id", "product_id", "key")
  WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_statuses_default_key_uq"
  ON "workspace_statuses" ("workspace_id", "key")
  WHERE "product_id" IS NULL;--> statement-breakpoint

ALTER TABLE "workspace_properties" DROP CONSTRAINT "workspace_properties_ws_entity_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_properties_product_key_uq"
  ON "workspace_properties" ("workspace_id", "product_id", "entity", "key")
  WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_properties_default_key_uq"
  ON "workspace_properties" ("workspace_id", "entity", "key")
  WHERE "product_id" IS NULL;--> statement-breakpoint

ALTER TABLE "detail_templates" DROP CONSTRAINT "detail_templates_ws_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "detail_templates_product_name_uq"
  ON "detail_templates" ("workspace_id", "product_id", "name")
  WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "detail_templates_default_name_uq"
  ON "detail_templates" ("workspace_id", "name")
  WHERE "product_id" IS NULL;--> statement-breakpoint

CREATE INDEX "workspace_statuses_product_idx"
  ON "workspace_statuses" ("product_id");--> statement-breakpoint
CREATE INDEX "workspace_stage_gates_product_idx"
  ON "workspace_stage_gates" ("product_id");--> statement-breakpoint
CREATE INDEX "workspace_properties_product_idx"
  ON "workspace_properties" ("product_id");--> statement-breakpoint
CREATE INDEX "detail_templates_product_idx"
  ON "detail_templates" ("product_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The two settings that become maps rather than rows.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "product_settings"
  ADD COLUMN "card_fields" jsonb;--> statement-breakpoint
ALTER TABLE "product_settings"
  ADD COLUMN "level_templates" jsonb;--> statement-breakpoint

COMMENT ON COLUMN "product_settings"."card_fields" IS
  'Per-level built-in field visibility: {levelKey: string[] | null}. An absent level inherits the workspace default; a null value overrides it to "every field". NULL column = no overrides at all.';--> statement-breakpoint
COMMENT ON COLUMN "product_settings"."level_templates" IS
  'Per-level default detail template: {levelKey: uuid | null}. An absent level inherits; a null value overrides it to "no template". NULL column = no overrides at all.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────
-- 4. RLS. Reads follow product visibility, writes require managing the
--    product (or owning the workspace, for the default rows).
--    `specboards_can_manage_product` already returns true for an org admin, so
--    a workspace owner keeps writing everything without a second branch.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS workspace_statuses_member_all ON "workspace_statuses";--> statement-breakpoint
CREATE POLICY workspace_statuses_read ON "workspace_statuses"
  FOR SELECT USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_member("workspace_id")
      ELSE specboards_can_read_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint
CREATE POLICY workspace_statuses_write ON "workspace_statuses"
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

DROP POLICY IF EXISTS workspace_stage_gates_member_all ON "workspace_stage_gates";--> statement-breakpoint
CREATE POLICY workspace_stage_gates_read ON "workspace_stage_gates"
  FOR SELECT USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_member("workspace_id")
      ELSE specboards_can_read_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint
CREATE POLICY workspace_stage_gates_write ON "workspace_stage_gates"
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

DROP POLICY IF EXISTS workspace_properties_member_all ON "workspace_properties";--> statement-breakpoint
CREATE POLICY workspace_properties_read ON "workspace_properties"
  FOR SELECT USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_member("workspace_id")
      ELSE specboards_can_read_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint
CREATE POLICY workspace_properties_write ON "workspace_properties"
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

DROP POLICY IF EXISTS detail_templates_member_all ON "detail_templates";--> statement-breakpoint
CREATE POLICY detail_templates_read ON "detail_templates"
  FOR SELECT USING (
    CASE WHEN "product_id" IS NULL
      THEN specboards_is_member("workspace_id")
      ELSE specboards_can_read_product("workspace_id", "product_id")
    END
  );--> statement-breakpoint
CREATE POLICY detail_templates_write ON "detail_templates"
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
  );
