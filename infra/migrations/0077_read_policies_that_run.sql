-- Make the read policies on `comments` and `assistant_messages` actually apply.
--
-- Both tables pair a product-scoped `_read` SELECT policy with a write policy
-- declared `FOR ALL`. In Postgres a `FOR ALL` policy's USING clause also governs
-- SELECT, and permissive policies of the same command combine with OR, so the
-- narrow read policy could not restrict anything: any workspace member
-- satisfied the broader one. The read policies have been inert since the day
-- they were written.
--
-- Proven by replaying every migration into a throwaway Postgres and querying as
-- the RLS-scoped app role, with a member who holds no grant on a `private`
-- product: `features` correctly returned nothing while `comments` and
-- `assistant_messages` both returned the private content.
--
-- 0068's own comment says the assistant thread must follow the item's product,
-- "which would otherwise be a way to read the item's content through the back
-- door". 0075 then rewrote a read policy that never applied.
--
-- The fix is the shape `features` and `spec_index` already use in 0012: split
-- the `FOR ALL` into per-command policies so nothing but the `_read` policy has
-- an opinion about SELECT. The write condition is carried over unchanged
-- (`specboards_is_member`), because who may write is not what was wrong here.
--
-- A consequence worth naming: with SELECT governed solely by the `_read`
-- policy, it now also governs the rows an UPDATE or DELETE may read, which is
-- how Postgres treats a command that references a table's columns in WHERE or
-- RETURNING. A member editing a comment on a product they cannot read was
-- already refused by the service layer; now the database refuses it too.
--
-- ONLY these two tables are affected. Nine other tables pair a `FOR ALL` with a
-- `_read` policy, and every one of those has a NARROWER `FOR ALL` condition
-- (`specboards_is_org_admin` or `specboards_can_manage_product`), so the union
-- is the read policy and they are already correct. Do not "fix" those.

DROP POLICY IF EXISTS comments_write ON "comments";--> statement-breakpoint

CREATE POLICY comments_insert ON "comments"
  FOR INSERT WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint

CREATE POLICY comments_update ON "comments"
  FOR UPDATE USING (specboards_is_member(workspace_id))
  WITH CHECK (specboards_is_member(workspace_id));--> statement-breakpoint

CREATE POLICY comments_delete ON "comments"
  FOR DELETE USING (specboards_is_member(workspace_id));--> statement-breakpoint

DROP POLICY IF EXISTS assistant_messages_write ON "assistant_messages";--> statement-breakpoint

CREATE POLICY assistant_messages_insert ON "assistant_messages"
  FOR INSERT WITH CHECK (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY assistant_messages_update ON "assistant_messages"
  FOR UPDATE USING (specboards_is_member("workspace_id"))
  WITH CHECK (specboards_is_member("workspace_id"));--> statement-breakpoint

CREATE POLICY assistant_messages_delete ON "assistant_messages"
  FOR DELETE USING (specboards_is_member("workspace_id"));
