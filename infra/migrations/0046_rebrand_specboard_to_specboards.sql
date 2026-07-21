-- Rebrand: rename the RLS helper functions specboard_* -> specboards_*.
--
-- RLS policies reference these functions by OID, not by name, so
-- `ALTER FUNCTION ... RENAME` is transparent to every policy: the ~50
-- tenant/product policies keep working untouched, with no drop-and-recreate.
-- Only the three composite helpers call the leaf helpers by name inside their
-- bodies, so after renaming we CREATE OR REPLACE those to point at the renamed
-- leaves. CREATE OR REPLACE keeps each function's OID, so the policies that call
-- them are unaffected too.
--
-- The database roles (specboard_app / specboard_worker) are provisioned OUTSIDE
-- the drizzle journal, in infra/rls-role.sql + infra/worker-role.sql. Their
-- rename is a coordinated, superuser-run cutover (ALTER ROLE ... RENAME, re-run
-- the scripts, swap DATABASE_URL_APP / DATABASE_URL_WORKER secrets) documented in
-- docs/RUNBOOK-db-role-cutover.md, and is intentionally NOT part of this
-- migration (renaming a role needs CREATEROLE, which the migration owner lacks).

-- Leaf helpers: no internal function calls, so renaming is all that's needed.
ALTER FUNCTION specboard_is_member(uuid) RENAME TO specboards_is_member;--> statement-breakpoint
ALTER FUNCTION specboard_is_org_admin(uuid) RENAME TO specboards_is_org_admin;--> statement-breakpoint

-- Composite helpers: rename in place first (preserves OID for dependent
-- policies), then re-point their bodies at the renamed leaf helpers below.
ALTER FUNCTION specboard_can_read_product(uuid, uuid) RENAME TO specboards_can_read_product;--> statement-breakpoint
ALTER FUNCTION specboard_can_write_product(uuid, uuid) RENAME TO specboards_can_write_product;--> statement-breakpoint
ALTER FUNCTION specboard_can_manage_product(uuid, uuid) RENAME TO specboards_can_manage_product;--> statement-breakpoint

-- Re-point the composite bodies at the renamed leaves. Bodies are copied verbatim
-- from their latest definitions (0012 initial; 0034 redefined can_write for the
-- role consolidation) with only the internal helper names updated.
CREATE OR REPLACE FUNCTION specboards_can_read_product(p_workspace uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT specboards_is_member(p_workspace) AND (
    p_product IS NULL
    OR specboards_is_org_admin(p_workspace)
    OR EXISTS (SELECT 1 FROM products pr WHERE pr.id = p_product AND pr.visibility = 'org')
    OR EXISTS (
      SELECT 1 FROM product_members pm
      WHERE pm.product_id = p_product
        AND pm.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION specboards_can_write_product(p_workspace uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT specboards_is_member(p_workspace) AND (
    specboards_is_org_admin(p_workspace)
    OR EXISTS (
      SELECT 1 FROM product_members pm
      WHERE pm.product_id = p_product
        AND pm.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND pm.role IN ('admin','contributor')
    )
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION specboards_can_manage_product(p_workspace uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT specboards_is_member(p_workspace) AND (
    specboards_is_org_admin(p_workspace)
    OR EXISTS (
      SELECT 1 FROM product_members pm
      WHERE pm.product_id = p_product
        AND pm.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND pm.role = 'admin'
    )
  );
$$;
