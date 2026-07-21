# RUNBOOK: database role cutover (app + worker)

The app connects to Postgres as the **table owner**, which bypasses RLS. Every
tenant-isolation guarantee then rests solely on hand-written `workspaceId`
filters in app code. This runbook activates two dedicated **non-owner** roles so
the database is a live backstop:

- **`specboards_app`** - the RLS-enforced connection for per-user tenant data
  (`DATABASE_URL_APP`). Covers backlog card "RLS non-owner role cutover".
- **`specboards_worker`** - a narrow connection for background / ingestion work:
  the outbox delivery drainer + relay and the incoming GitHub webhook sink
  (`DATABASE_URL_WORKER`). Covers backlog card "Dedicated DB roles for
  outbox/webhook workers".

Both are **provision-and-set-one-env-var** changes. The application code already
prefers the scoped connections when the env vars are set and falls back to the
owner connection when they are not, so this is a safe, reversible cutover with no
code deploy required. Do **test first, smoke-test, then prod** (the
cloud-test-first rule).

Auth, onboarding, invitations, API-key verification, and OAuth stay on the owner
connection (`getDb()`) by design: they run without a user scope and touch tables
the scoped roles are intentionally not granted.

---

## Part 0 - rebrand role rename (existing databases only)

The scripts and this runbook now use the `specboards_*` role names. Databases
provisioned before the Specboard -> Specboards rebrand already have the roles
under the **old** names (`specboard_app`, `specboard_worker`). On those clusters,
rename in place before anything else. `ALTER ROLE ... RENAME` preserves every
grant, default privilege, and role-targeted policy (policies track roles by OID),
so no re-granting is needed:

```sql
-- As a superuser / the table owner, on test first, then prod:
ALTER ROLE specboard_app    RENAME TO specboards_app;
ALTER ROLE specboard_worker RENAME TO specboards_worker;
```

Then update the connection secrets to use the new role name in the URL and
restart so pooled connections reconnect:

```bash
fly secrets set DATABASE_URL_APP='postgres://specboards_app:<pw>@<host>:5432/<db>'    -a specboard-test
fly secrets set DATABASE_URL_WORKER='postgres://specboards_worker:<pw>@<host>:5432/<db>' -a specboard-test
```

Re-running `infra/rls-role.sql` / `infra/worker-role.sql` afterward is safe
(idempotent) and reconciles the grants under the new name. Fresh databases skip
this part: the scripts create the roles under the new names directly.

The RLS helper functions (`specboards_is_member`, ...) are renamed by the drizzle
migration `0046_rebrand_specboard_to_specboards.sql`, applied via `pnpm db:migrate`
as usual; that is independent of this role rename.

---

## Part 1 - `specboards_app` (RLS non-owner cutover)

### Preconditions

- Every tenant table has RLS enabled **and** at least one policy (migrations
  0002 / 0012 and later). No enabled-but-unpolicied table (which would deny all
  rows to a non-owner).
- The RLS helper functions (`specboards_is_member`,
  `specboards_can_read_product`, ...) are `SECURITY DEFINER`, so the role needs
  only `EXECUTE`.
- `getStore()` already uses `DATABASE_URL_APP` when set and `DbStore.scoped()`
  sets the transaction-local `app.user_id` the policies key on.

### Cutover

1. **Provision the role** as a superuser / the table owner:
   ```sh
   psql "$SUPERUSER_URL" -f infra/rls-role.sql
   ```
2. **Set a login + password** (kept out of git):
   ```sql
   alter role specboards_app with login password '<generated-strong-password>';
   ```
3. **Point the app at it**, then redeploy. Leave the owner `DATABASE_URL` as-is:
   ```sh
   fly secrets set DATABASE_URL_APP='postgres://specboards_app:<pw>@<host>:5432/<db>' -a specboard-test
   ```
4. **Smoke-test on test** (see the shared checklist below) before prod.
5. **Repeat for prod** (`app specboard`) once test is green.

### Rollback

Unset `DATABASE_URL_APP` and redeploy: the store falls straight back to the
owner connection. No data or schema change is involved.

---

## Part 2 - `specboards_worker` (background / ingestion role)

The outbox drainer/relay and the incoming GitHub webhook sink span **every**
workspace and run with no `app.user_id`, so they cannot use the RLS-scoped app
connection. Historically they ran on the owner connection (full RLS bypass).
This role narrows them to the exact tables they touch, with role-targeted RLS
policies granting the cross-workspace access they legitimately need and nothing
else.

### What the role can reach (verified surface)

Grants are scoped to exactly these tables (`infra/worker-role.sql`); the role
has **no** grant on auth, `api_keys`, `members`, `comments`, `activity_log`,
`releases`, `ideas`, `saved_views`, `feature_links`, `board_preferences`, or any
other table, so a bug in a worker path cannot reach them.

- Outbound delivery: `outbox_events` (S/U/D), `webhook_endpoints` (S/U),
  `webhook_deliveries` (S/I/U).
- Incoming GitHub sync: `github_app` (S), `github_installations` (S/D),
  `repositories` (S/U), `feature_github_links` (S/I/U/D), `workspace_levels`
  (S), `features` (S/I/U/D), `spec_index` (S/I/U/D), `products` (S/I/U).
- Read-only context: `workspaces` (S), `users` (S).

Cross-workspace access on the RLS-enabled tables above comes from role-targeted
policies (`<table>_worker_all ... FOR ALL TO specboards_worker USING (true)`).
Because they are targeted `TO specboards_worker`, they do **not** loosen RLS for
`specboards_app` or any other role. (Verified against Postgres 16: the worker
role sees rows across all workspaces, the app role still sees only its member
workspace, and the worker role is denied on ungranted tables.)

### Cutover

1. **Provision the role** as a superuser / the table owner:
   ```sh
   psql "$SUPERUSER_URL" -f infra/worker-role.sql
   ```
2. **Set a login + password** (kept out of git):
   ```sql
   alter role specboards_worker with login password '<generated-strong-password>';
   ```
3. **Point the workers at it**, then redeploy. Leave `DATABASE_URL` and
   `DATABASE_URL_APP` as-is:
   ```sh
   fly secrets set DATABASE_URL_WORKER='postgres://specboards_worker:<pw>@<host>:5432/<db>' -a specboard-test
   ```
4. **Smoke-test on test** (checklist below) before prod.
5. **Repeat for prod** (`app specboard`) once test is green.

### If a delivery or sync fails with `permission denied for table X`

The worker surface is deliberately fixed (unlike `specboards_app`, new tables are
not auto-granted). If a legitimate worker path touches a table not in the list
above, the test smoke-test will surface a `permission denied` error before prod.
Add the needed grant (and, if the table has RLS, a `_worker_all` policy) to
`infra/worker-role.sql`, re-run it on both databases, and re-test. Until then,
unset `DATABASE_URL_WORKER` to fall back to the owner connection.

### Rollback

Unset `DATABASE_URL_WORKER` and redeploy: `getWorkerDb()` falls straight back to
the owner connection. No data or schema change is involved.

---

## Smoke-test checklists

### After the `specboards_app` cutover (test, then prod)

- Sign in; the board loads (reads go through the RLS role).
- Create / edit / move a work item; change its status (writes pass RLS).
- Create a second product, make it private; confirm a non-grantee member cannot
  see it and the owner/admin can.
- Connect or re-sync a repo (owner-side ingestion still works via `getDb()`).

If any read returns empty or a write 500s with a permission error, unset
`DATABASE_URL_APP` to fall back instantly, and investigate before retrying.

### After the `specboards_worker` cutover (test, then prod)

- **Outbound delivery:** register a webhook endpoint, make a change that emits an
  event (create/move an item), and confirm the delivery is sent (a `delivered`
  row appears, the endpoint receives the signed envelope). This exercises
  `outbox_events` -> relay -> `webhook_deliveries` on the worker role.
- **SSRF still enforced:** point an endpoint at `http://127.0.0.1/`, trigger a
  delivery, confirm it is marked `failed` (blocked URL).
- **Incoming sync:** push a spec change to a connected repo's default branch and
  confirm it reconciles into `features` + `spec_index` (the item updates in the
  app). This exercises the whole GitHub sink on the worker role.
- **Outbox prune:** confirm no errors in the hourly prune log
  (`[webhooks] pruned N processed outbox events`).

Watch the logs for `permission denied for table ...`; if one appears, follow the
"permission denied" note above. Unset `DATABASE_URL_WORKER` to fall back.

---

## Follow-ups

- Rotate the `specboards_app` / `specboards_worker` passwords on the normal secret
  cadence.
- Consider `ALTER TABLE ... FORCE ROW LEVEL SECURITY` only if either role ever
  ends up owning a table (they should not).
- If a later migration adds a table a worker path must touch, extend
  `infra/worker-role.sql` and re-run it per environment (see the note above).
