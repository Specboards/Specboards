# RLS non-owner role cutover

## Why

The app connects to Postgres as the table owner, which **bypasses RLS**. Every
tenant-isolation guarantee therefore rests on hand-written `workspaceId` filters
in application code, with no database backstop: one missed filter is a full
cross-tenant breach. Migrations 0002 and 0012 already define complete,
policied RLS on every tenant table. Connecting as a non-owner role activates
that second line of defense.

The code is already wired for this: `getStore()` uses `DATABASE_URL_APP` when
set (falling back to `DATABASE_URL`), and `DbStore.scoped()` sets the
transaction-local `app.user_id` the policies key on. Auth, onboarding, webhook
ingestion, and API-key verification stay on the owner connection (`getDb()`) by
design, because they run without a user scope. So no code change is needed:
this is purely provisioning the role and setting one env var per environment.

## Preconditions (verified 2026-07-01)

- Every tenant table (`workspaces`, `members`, `repositories`, `features`,
  `comments`, `activity_log`, `spec_index`, `products`, `product_members`,
  `saved_views`, `board_preferences`, `workspace_levels`, `feature_links`,
  `feature_github_links`) has RLS enabled **and** at least one policy. No
  enabled-but-unpolicied table (which would deny all rows to a non-owner).
- The RLS helper functions (`specboard_is_member`, `specboard_can_read_product`,
  etc.) are `SECURITY DEFINER`, so the role needs only `EXECUTE`.

## Cutover (test first, per the cloud-test-first rule)

Do this on **test** end to end, smoke-test, then repeat for **prod**.

1. **Provision the role.** Connect to the database as a superuser (via
   `fly postgres connect` / the proxy) and run the committed script:

   ```sh
   psql "$SUPERUSER_URL" -f infra/rls-role.sql
   ```

2. **Set a login + password** (kept out of git):

   ```sql
   alter role specboard_app with login password '<generated-strong-password>';
   ```

3. **Set the app env var** to a connection string for that role, then deploy:

   ```sh
   fly secrets set DATABASE_URL_APP='postgres://specboard_app:<password>@<host>:5432/<db>' -a specboard-test
   ```

   Leave `DATABASE_URL` (owner) as-is; both are needed.

4. **Smoke-test on test** before touching prod:
   - Sign in; the board loads (reads go through the RLS role).
   - Create / edit / move a work item; a status change (writes pass RLS).
   - Create a second product, make it private, confirm a non-grantee member
     cannot see it and the owner/admin can.
   - Connect or re-sync a repo (owner-side ingestion still works via `getDb()`).
   - Confirm the webhook still reconciles a push (owner connection).
   If any read returns empty or a write 500s with a permission error, unset
   `DATABASE_URL_APP` to instantly fall back to the owner connection, and
   investigate before retrying.

5. **Repeat for prod** (`specboard-prod-db`, app `specboard`) once test is green.

## Rollback

Unset `DATABASE_URL_APP` and redeploy. The store falls straight back to the
owner connection; no data or schema change is involved.

## Follow-ups

- Consider `ALTER TABLE ... FORCE ROW LEVEL SECURITY` only if `specboard_app`
  ever ends up owning a table (it should not).
- Rotate the `specboard_app` password on the normal secret cadence.
