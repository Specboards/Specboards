# RUNBOOK: database role cutover (app + worker + portal)

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
- **`specboards_portal`** - a read-only connection for the public Ideas portal
  and public roadmap (`DATABASE_URL_PORTAL`), the only surface served to
  somebody with no account. Covers backlog card "Portal database role and RLS
  policies for the anonymous reader".

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

The RLS helper functions (`specboards_is_member`, ...) were renamed by the drizzle
migration `0046_rebrand_specboard_to_specboards.sql`, applied via `pnpm db:migrate`
as usual; that is independent of this role rename. That file was folded into
`0000_baseline.sql` when the history was squashed in v1.0.2, so the names it
produced are what a database now starts with; read it in git history before
that release if you need the rename itself.

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
has **no** grant on auth, `api_keys`, `comments`, `activity_log`, `releases`,
`ideas`, `saved_views`, `feature_links`, `board_preferences`, or any other
table, so a bug in a worker path cannot reach them.

- Outbound delivery: `outbox_events` (S/U/D), `webhook_endpoints` (S/U),
  `webhook_deliveries` (S/I/U).
- Incoming GitHub sync: `github_app` (S), `github_installations` (S/D),
  `repositories` (S/U), `feature_github_links` (S/I/U/D), `workspace_levels`
  (S), `features` (S/I/U/D), `spec_index` (S/I/U/D), `products` (S/I/U).
- Notification fan-out: `notifications` (S/I), `members` (S),
  `notification_defaults` (S), `notification_preferences` (S),
  `item_watchers` (S/I/U), `product_members` (S).
- Read-only context: `workspaces` (S), `users` (S).

`users` is read for two things now. The relay builds an emailed notification
from it (name, address) and honours
`users.notification_email_opted_out_at`, the master unsubscribe switch. Still
select-only: the worker reads somebody's decision and never records one. The
unsubscribe link itself writes that column on the owner connection, because it
carries no session and the signed token in the URL is the authorization.

`product_members` is select-only, added in migration 0007. Being in the
workspace is not the same as being able to see an item: a private product is
readable only by its own members and the workspace owner, and the fan-out had
no way to tell, because this is the roster that says so. Telling somebody
anyway wrote them an in-app row the inbox then hid behind its join to
`features`, and sent them an email whose subject carried the title of work they
had deliberately not been given access to. The worker reads who may see a
product and can no more change it than it can change who belongs to a
workspace.

`members` is select-only, and is the one place the worker reads the roster: the
fan-out has to drop a deactivated or departed person from a recipient list, and
a notification is the one thing that would otherwise keep arriving for someone
who has left. It can read the roster and cannot change it.

`item_watchers` is the one write in the notification path that is not a
notification, and the reason is the assignment case: being handed an item
auto-watches you, and the person doing the handing is not the person who ends
up watching. Doing that at the write site would need an RLS policy letting any
member insert a watch row for anybody, which is a way to subscribe a colleague
to an item they never asked about. It has no DELETE, so the worker can add
somebody to an item they just acted on and can never undo a decision a person
made about their own attention.

The two settings tables are select-only for the same kind of reason. Resolving
who to tell means reading what each recipient asked for, and the worker has no
business writing anybody's settings on their behalf. Note that these two are
also granted by migration `0002`, so a database that has run migrations already
honours preferences without this file being re-run; the entry here is what
keeps a freshly provisioned database (where the migration's grant is skipped
because the role does not exist yet) from silently ignoring everybody's
choices.

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
`infra/worker-role.sql`, re-run it on both databases, and re-test. On a
single-tenant deployment you can unset `DATABASE_URL_WORKER` to fall back to
the owner connection in the meantime; a multi-tenant deployment refuses to
boot without a verified worker connection (see `assertWorkerIsolation` in
`apps/web/src/lib/rls-guard.ts`), so there the grant fix is the only path.

### Rollback

Single-tenant: unset `DATABASE_URL_WORKER` and redeploy; `getWorkerDb()` falls
back to the owner connection. No data or schema change is involved.

Multi-tenant (hosted): the owner fallback is refused by design, both at boot
(`assertWorkerIsolation`) and in `getWorkerDb()`. Rolling back means fixing the
worker role's grants or pointing `DATABASE_URL_WORKER` at a corrected non-owner
role, not removing the variable.

---

## Part 3 - `specboards_portal` (public portal reader)

The portal serves people with no account and no membership. It therefore cannot
use `specboards_app`, whose policies key on `app.user_id` and correctly match
nothing for a stranger, and must not use the owner connection, which bypasses
RLS entirely: on a page rendered for the public that would make one forgotten
predicate the difference between a portal and an unannounced product's backlog
on a public URL.

### What the role can reach (verified surface)

`SELECT` only, on exactly eight tables: `workspaces`, `idea_settings`,
`idea_portal_products`, `products`, `ideas`, `idea_votes`, `releases`,
`features`. No `INSERT`, `UPDATE` or `DELETE` anywhere, on any table. Public
submissions and votes are writes and go through their own intake path on a
different connection.

Unlike `specboards_app`, new tables are **not** auto-granted: `infra/portal-role.sql`
issues no blanket grant and sets no `ALTER DEFAULT PRIVILEGES`, so a table added
by a later migration is unreachable until somebody grants it on purpose. That is
deliberate. Silence should mean "no" for the public reader even where it means
"yes" for the tenant role.

Within those tables, row visibility is decided by role-targeted policies that
encode publication itself (migration `0009_idea_portal_reader.sql`), plus
`RESTRICTIVE` clamps so the reach cannot be widened by any other policy. An
unpublished product, an unpublished review stage, a roadmap that is switched off
and a portal that is switched off are each refused by the database regardless of
what the application asks for.

### Preconditions

Migration `0009_idea_portal_reader.sql` must already be applied to the database,
because `infra/portal-role.sql` calls the function that migration creates. That
happens automatically on deploy (`release_command = "node migrate.mjs"`), so in
practice: **deploy first, then run this**. If the script errors with `function
specboards_portal_apply_grants() does not exist`, that is the migration not
being there yet.

Deploying ahead of provisioning is safe: the migration's grants are guarded on
the role existing, so until this runbook is followed the portal simply has no
reader and every portal URL 404s.

**This was not always true, and the correction is worth knowing.** The first
version of the boot guard refused to start a multi-tenant deployment with no
`DATABASE_URL_PORTAL`, copying `assertWorkerIsolation`. Because the guard shipped
in the same change as the feature, it took the test deployment down for hours:
the app would not boot to be provisioned, and this page said the deploy was safe
while the code disagreed. Workers are mandatory, so failing closed is right for
them; a portal is optional, and a deployment without one is not degraded. The
guard now returns quietly and `getPortalDb()` returns null.

### Cutover

1. **Provision the role** as a superuser / the table owner:
   ```sh
   psql "$SUPERUSER_URL" -f infra/portal-role.sql
   ```
2. **Set a login + password** (kept out of git):
   ```sql
   alter role specboards_portal with login password '<generated-strong-password>';
   ```
3. **Point the portal at it**, then redeploy. Leave the other three connection
   strings as they are:
   ```sh
   fly secrets set DATABASE_URL_PORTAL='postgres://specboards_portal:<pw>@<host>:5432/<db>' -a specboard-test
   ```
4. **Smoke-test on test** (checklist below) before prod.
5. **Repeat for prod** (`app specboard`) once test is green.

### If a portal page is empty when it should not be

Check in this order, because the first is by far the most likely:

1. **Is anything actually published?** Everything defaults to publishing
   nothing: empty status list, empty product set, roadmap off. A portal with
   `portal_enabled = true` and nothing else chosen is *correctly* empty.
2. **Was `infra/portal-role.sql` run after the migration?** If the role was
   created but the script was run before migration 0009, it will have errored on
   the missing function and granted nothing. Re-run it; it is idempotent.
3. **`permission denied for table X`** means a portal query reached a table
   outside the eight above. Decide whether a stranger on the internet should
   read that table before adding the grant to `infra/portal-role.sql`; if yes,
   add a role-targeted policy and a `RESTRICTIVE` clamp with it, then re-run the
   script on both databases.

### Rollback

Single-tenant: unset `DATABASE_URL_PORTAL` and redeploy; `getPortalDb()` falls
back to the owner connection. No data or schema change is involved.

Multi-tenant (hosted): the same. Unsetting `DATABASE_URL_PORTAL` turns the
portal off everywhere rather than falling back to the owner connection, in
either tenancy mode, because a public surface reading on the connection that
bypasses every publication policy is not a fallback worth having.

To take one workspace's portal down without touching infrastructure, switch off
`portal_enabled` in Settings -> Ideas. That is a single setting and the
RESTRICTIVE clamp policies make it total.

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

### After the `specboards_portal` cutover (test, then prod)

Every check here is about something that must **not** appear. A portal that
renders is not evidence of anything; a portal that renders exactly what was
published is.

- [ ] Boot log says `portal connection verified RLS-safe and publication-scoped.`
      Its absence means `DATABASE_URL_PORTAL` is unset, and the app boots
      normally with every portal URL 404ing. A refusal to BOOT means the
      connection is set but can read an unpublished row, which is the
      misconfiguration this guard exists for (pointing it at the owner
      connection does exactly that).
- [ ] With a workspace's portal enabled and one product and one stage published:
      the portal shows ideas from that product at that stage, and nothing else.
- [ ] A second, unpublished product in the same workspace: its **name** does not
      appear anywhere on the portal.
- [ ] An idea at an unpublished stage (e.g. `declined`) does not appear.
- [ ] A different workspace with its portal off: its slug does not resolve, and
      nothing of its content is reachable.
- [ ] Roadmap off: no roadmap. Roadmap on with one item status published: only
      items at that status.
- [ ] Switch `portal_enabled` off: the whole portal goes away, not just the
      ideas list.

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
"permission denied" note above (single-tenant can unset `DATABASE_URL_WORKER`
to fall back; multi-tenant must fix the grants).

---

## Follow-ups

- Rotate the `specboards_app` / `specboards_worker` passwords on the normal secret
  cadence.
- Consider `ALTER TABLE ... FORCE ROW LEVEL SECURITY` only if either role ever
  ends up owning a table (they should not).
- If a later migration adds a table a worker path must touch, extend
  `infra/worker-role.sql` and re-run it per environment (see the note above).
