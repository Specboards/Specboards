-- Role consolidation.
--   Org member_role:      admin/pm/ux/eng/viewer  ->  owner/member
--                         (admin -> owner; everyone else -> member)
--   Product member_role:  admin/editor/viewer     ->  admin/contributor/viewer
--                         (editor -> contributor; rename in place)
-- Hand-authored: drizzle-kit can't map old enum values to new ones, and this
-- must also carry the per-product invite grants column and redefine the RLS
-- helpers that embed role literals.

-- 1. Per-product grants applied when an invitation is accepted.
ALTER TABLE "invitations" ADD COLUMN "product_grants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- 2. product_member_role: rename 'editor' -> 'contributor' in place (a value
--    rename preserves existing rows and is safe to use later in this tx).
ALTER TYPE "public"."product_member_role" RENAME VALUE 'editor' TO 'contributor';--> statement-breakpoint

-- 3. member_role: can't drop enum values, so swap the type. Map old->new with a
--    CASE in the USING clause (admin -> owner, all others -> member) on both
--    columns that use it (members, invitations), resetting their defaults.
ALTER TYPE "public"."member_role" RENAME TO "member_role_old";--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint

ALTER TABLE "members" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "role" SET DATA TYPE "public"."member_role"
  USING (CASE "role"::text WHEN 'admin' THEN 'owner' ELSE 'member' END)::"public"."member_role";--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint

ALTER TABLE "invitations" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DATA TYPE "public"."member_role"
  USING (CASE "role"::text WHEN 'admin' THEN 'owner' ELSE 'member' END)::"public"."member_role";--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint

DROP TYPE "public"."member_role_old";--> statement-breakpoint

-- 4. Redefine the RLS helpers that embed the old role literals.
--    Org admin is now the workspace 'owner' (and must be active).
CREATE OR REPLACE FUNCTION specboard_is_org_admin(target_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM members m
    WHERE m.workspace_id = target_workspace
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.role = 'owner'
      AND m.deactivated_at IS NULL
  );
$$;--> statement-breakpoint

--    Product write is now org owner OR a product admin/contributor.
CREATE OR REPLACE FUNCTION specboard_can_write_product(p_workspace uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT specboard_is_member(p_workspace) AND (
    specboard_is_org_admin(p_workspace)
    OR EXISTS (
      SELECT 1 FROM product_members pm
      WHERE pm.product_id = p_product
        AND pm.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND pm.role IN ('admin','contributor')
    )
  );
$$;
-- specboard_can_manage_product still keys on product 'admin' (unchanged);
-- specboard_can_read_product has no role literal (unchanged).
