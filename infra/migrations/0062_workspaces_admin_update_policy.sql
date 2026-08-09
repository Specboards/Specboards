-- Let an org owner actually update their own workspace row.
--
-- `workspaces` has had RLS enabled with exactly one policy for the app role,
-- `workspaces_member_select`, which is FOR SELECT. `specboards_worker` has its
-- own FOR ALL policy, and the table owner bypasses RLS, so nothing looked
-- wrong: reads worked everywhere and the worker could write.
--
-- But tenant writes go through the store, which connects as `specboards_app`
-- (DATABASE_URL_APP). That role inherits UPDATE on the table from the `writer`
-- role, so the privilege check passes and the statement runs; RLS then finds no
-- applicable UPDATE policy and the statement matches zero rows. Postgres does
-- not error on that, it just updates nothing.
--
-- The visible symptom was Settings > Cards > Workflow > Transitions: choosing
-- Flexible reported success and the board stayed strict, because
-- `setTransitionMode` is the only tenant-path write to this table. Every
-- workspace has therefore kept whatever value migration 0050 backfilled (or the
-- column default, for workspaces created since), and no admin has ever been
-- able to change it from the app.
--
-- The predicate mirrors the app-layer gate the route already applies
-- (`authorizeOrgAdmin`): owner of THIS workspace, and `specboards_is_org_admin`
-- is the existing helper for exactly that. WITH CHECK repeats it so an owner
-- cannot move a row out of their own workspace.

CREATE POLICY workspaces_admin_update ON "workspaces"
  FOR UPDATE USING (specboards_is_org_admin(id))
  WITH CHECK (specboards_is_org_admin(id));
