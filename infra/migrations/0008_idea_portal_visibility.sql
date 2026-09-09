-- What a public Ideas portal is allowed to show.
--
-- `idea_settings` has carried `portal_enabled` and `portal_title` since 0026 in
-- the old history, and nothing else. That was enough to configure a portal and
-- is not enough to publish one: it says the portal is on and what to call it,
-- and says nothing about which of a workspace's products appear, which review
-- stages are fit for outsiders to read, or whether the roadmap is included.
--
-- Shipping the public views first and adding these later is the one order that
-- cannot work. The first version would have to decide the rules by accident,
-- and whatever it decided would immediately be the behaviour every existing
-- portal depends on. So the model lands before anything can read it.
--
-- ── Everything defaults to publishing nothing ──────────────────────────────
-- Empty arrays and an empty product set, so a workspace that flips
-- `portal_enabled` without choosing anything gets an empty portal rather than
-- its whole backlog. The opposite default is one migration away from
-- publishing an unannounced product's name to the internet, and the admin who
-- would have caught it is the one who has not opened the settings page yet.
--
-- The cost is that enabling a portal takes two steps instead of one. The
-- settings UI covers that by pre-selecting a sensible set for the admin to
-- review and save, which keeps the deliberate act in front of a person without
-- making them assemble the answer from nothing.

-- ── Idea stages are text keys, not a foreign key ───────────────────────────
-- Deliberately not a reference to `idea_statuses`. A workspace that has never
-- customised its review workflow has NO rows there at all: `resolveIdeaStages`
-- falls back to the built-in defaults whenever fewer than two are defined, so
-- the keys a portal must name (`new`, `under_review`, ...) frequently exist
-- only in code. An FK would be unenforceable for exactly the workspaces most
-- likely to turn a portal on first.
--
-- The consequence is that a renamed-away stage can leave a dead key in this
-- array. That fails safe: a key matching no stage publishes nothing, which is
-- the direction an unresolvable value should fail on a public surface.
ALTER TABLE idea_settings
    ADD COLUMN portal_idea_statuses text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- The public roadmap is a separate surface from the ideas list and is gated
-- separately: wanting customer feedback in the open is not the same decision as
-- publishing what you plan to build and when.
ALTER TABLE idea_settings
    ADD COLUMN portal_roadmap_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Item statuses, same reasoning as the idea stages above: the workflow is
-- workspace-defined, so these are keys rather than references. Internal stage
-- names are also often unflattering in public (`blocked`, `in_review`), which
-- is the other half of why this is a choice and not the whole set.
ALTER TABLE idea_settings
    ADD COLUMN portal_roadmap_item_statuses text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- Whether a public submission is visible at once or waits for an admin.
--
-- Defaults to review-first for both new and existing rows. An unmoderated form
-- on a customer's branded page is a spam and reputation liability, and a
-- workspace that has not yet been asked the question has not chosen to take
-- that on. Opting into immediate publication should be an act, not an
-- inheritance.
ALTER TABLE idea_settings
    ADD COLUMN portal_moderation text NOT NULL DEFAULT 'review_first';
--> statement-breakpoint

-- A CHECK rather than an enum type: the set is small, and altering a CHECK is
-- an ordinary migration where extending an enum is not transactional in older
-- Postgres and cannot be reverted in the same one.
ALTER TABLE idea_settings
    ADD CONSTRAINT idea_settings_portal_moderation_chk
    CHECK (portal_moderation IN ('review_first', 'immediate'));
--> statement-breakpoint

-- ── Which products the portal exposes ──────────────────────────────────────
-- A join table rather than an array of ids on `idea_settings`, for the
-- composite foreign key below. It is the reason this is worth an extra table.
CREATE TABLE idea_portal_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per product per workspace; re-publishing a product is idempotent
-- rather than an accumulation of duplicate rows the reader has to de-dupe.
ALTER TABLE idea_portal_products
    ADD CONSTRAINT idea_portal_products_ws_product_uq UNIQUE (workspace_id, product_id);
--> statement-breakpoint

-- The point of the table.
--
-- `product_id` alone would let a row name a product belonging to a different
-- workspace, and this is the one table in the schema where that mistake is
-- published to the internet rather than shown to a member who would report it.
-- The composite reference makes it unrepresentable: a row can only name a
-- product whose own `workspace_id` matches this row's. Same shape as
-- `product_repositories_product_ws_fk`, for the same reason.
--
-- App-code filters and (later) an RLS policy also enforce this. Three
-- independent guards is the right number for the only surface with no
-- authenticated reader to notice a leak.
ALTER TABLE idea_portal_products
    ADD CONSTRAINT idea_portal_products_product_ws_fk
    FOREIGN KEY (product_id, workspace_id) REFERENCES products(id, workspace_id);
--> statement-breakpoint

CREATE INDEX idea_portal_products_ws_idx ON idea_portal_products (workspace_id);
--> statement-breakpoint
CREATE INDEX idea_portal_products_product_idx ON idea_portal_products (product_id);
--> statement-breakpoint

ALTER TABLE idea_portal_products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Matches `idea_settings_member_all`: this is portal configuration, so a member
-- of the workspace reads and writes it and nobody else does.
--
-- Note what is NOT here: any policy admitting an unauthenticated reader. That
-- is deliberate and it is not an oversight. A portal visitor is not a member,
-- so on the tenant role this table (like `ideas` and `idea_settings`) currently
-- returns no rows to the public path at all. Giving the portal a reader is its
-- own piece of work, with its own role and its own grants, and it is not
-- something to slip into a migration that adds columns.
CREATE POLICY idea_portal_products_member_all ON idea_portal_products
    USING (public.specboards_is_member(workspace_id))
    WITH CHECK (public.specboards_is_member(workspace_id));
--> statement-breakpoint

-- `infra/rls-role.sql` sets ALTER DEFAULT PRIVILEGES for specboards_app, so a
-- table created by the migration owner is already reachable by the tenant role
-- and needs no grant here. The worker role gets nothing: the notification relay
-- has no reason to read portal configuration.
COMMENT ON TABLE idea_portal_products IS
    'Products a workspace publishes on its public Ideas portal. Empty means none.';
