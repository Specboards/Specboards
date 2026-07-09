# Migration Plan: Fly.io Hosting + Better Auth (drop Supabase)

**Status: executed 2026-06-12** (Phases 1–3 complete; see [Next steps](#next-steps)
for what remains). Amends the stack decision in [`PLAN.md`](./PLAN.md) and the
deployment section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).

Landed beyond the original scope of this plan, same date:

- **Consumer email-domain blocking:** sign-ups from gmail/outlook/yahoo/etc.
  are rejected when `SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS` is truthy
  (helper + list in `@specboard/core`, hook in `apps/web/src/lib/auth.ts`).
  On for both Fly apps, off by default for self-host.
- **Versioned API layer:** `GET /api/v1/features`,
  `GET`/`PATCH /api/v1/features/:specId` (`lib/features-service.ts`); all UI
  mutations go through it (`lib/api-client.ts`), server actions removed.
- **Postmark email delivery:** `lib/email.ts` posts to Postmark's HTTP API;
  Better Auth verification + password-reset emails. No-op with a logged
  warning when `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM` are unset.
- The RLS policies became a **journaled** drizzle migration
  (`infra/migrations/0002_rls_policies.sql`) instead of a manual psql step.
  `pnpm db:migrate` applies the entire chain.

## Decision & rationale

- **Hosting (SaaS):** Fly.io Machines running the existing
  `infra/web.Dockerfile`. The hosted product runs the *same image*
  self-hosters run via docker-compose (strong open-core parity). Fly also
  handles the long-lived processes we need later (webhook reconciler, remote
  MCP server over streamable HTTP/SSE) that serverless platforms make awkward.
- **Database (SaaS):** plain Postgres on Fly.io. (Originally Fly Managed
  Postgres / MPG; moved to legacy Fly Postgres on 2026-06-29 for cost, see the
  Operational reference below. The schema is provider-agnostic, so this is a
  hosting choice, not an app change.) The Supabase↔Fly partnership was
  deprecated April 2025, and depending on Supabase-specific features (Auth,
  `auth.uid()` in RLS) would have forced self-hosters to run the full Supabase
  stack or forked the auth code path.
- **Auth:** [Better Auth](https://better-auth.com), a TypeScript library that
  runs *inside* the Next.js app against our own Postgres. One auth
  implementation for self-host and SaaS; no external provider.
- **Why now:** the Supabase coupling is still trivially small (verified
  2026-06-12): a dead client stub with **zero imports**
  (`apps/web/src/lib/supabase.ts`), two unused npm deps, one
  Supabase-specific function call (`auth.uid()`) in
  `infra/supabase/migrations/0001_rls_policies.sql`, and doc text. Once real
  auth ships on Supabase, unwinding it means migrating live users.

## Verified Supabase touchpoint inventory

| Touchpoint | Action |
| --- | --- |
| `apps/web/src/lib/supabase.ts` (unused stub) | delete |
| `@supabase/ssr`, `@supabase/supabase-js` in `apps/web/package.json` | remove; add `better-auth` |
| `auth.uid()` in `infra/supabase/migrations/0001_rls_policies.sql:20` | rewrite to session-variable RLS |
| `infra/supabase/migrations/` dir + `packages/db/drizzle.config.ts` out path | move to `infra/migrations/` |
| Comments: `packages/db/src/schema.ts:38`, `packages/db/src/client.ts:9`, `infra/docker-compose.yml:1-2`, `apps/web/src/lib/store/db.ts:13` | reword |
| Docs: `ARCHITECTURE.md` lines 48, 62, 66, 85, 101, 107, 123; `README.md` (layout + Database sections) | update |

Self-host is **already** plain Postgres via docker-compose. Nothing changes
for self-hosters except auth becoming available to them (it was previously
planned as Supabase/SaaS-only).

---

## Phase 1: Code changes (repo)

### 1.1 Dependency swap

```bash
pnpm --filter @specboard/web remove @supabase/ssr @supabase/supabase-js
pnpm --filter @specboard/web add better-auth
```

Verified: `better-auth@1.6.17` resolves and installs cleanly in this
workspace.

### 1.2 Auth tables in `packages/db/src/schema.ts`

Better Auth needs `user` / `session` / `account` / `verification` tables. Use
**Postgres-generated UUID ids** (not Better Auth's default text ids) so they
line up with the existing uuid user references (`members.user_id`,
`comments.author_id`, `features.assignee_id`). Add `boolean` to the
`drizzle-orm/pg-core` import, then:

```ts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Credential or OAuth provider link (email/password hashes live here). */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Keep `members.user_id` as a plain uuid (no FK to `users.id`) so a
single-workspace self-host can still run with auth disabled. Update its
comment (currently references `Supabase auth.users.id`).

### 1.3 Better Auth server instance: `apps/web/src/lib/auth.ts`

Replaces the deleted `lib/supabase.ts`. Mirrors the `getStore()` pattern:
gated on `DATABASE_URL`, resolved once per process, `null` in local file mode.

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { createDb, schema } from "@specboard/db";

let auth: ReturnType<typeof betterAuth> | null | undefined;

export function getAuth() {
  if (auth === undefined) {
    const url = process.env.DATABASE_URL;
    auth = url
      ? betterAuth({
          database: drizzleAdapter(createDb(url), {
            provider: "pg",
            schema: {
              user: schema.users,
              session: schema.sessions,
              account: schema.accounts,
              verification: schema.verifications,
            },
          }),
          emailAndPassword: { enabled: true },
          advanced: {
            // Postgres mints UUID ids (see schema) instead of Better Auth's
            // default text ids.
            database: { generateId: false },
          },
        })
      : null;
  }
  return auth;
}
```

Note: `@specboard/db` must export `users`/`sessions`/`accounts`/
`verifications` from its index (it already re-exports `schema`).

### 1.4 Route handler: `apps/web/src/app/api/auth/[...all]/route.ts`

```ts
import { getAuth } from "@/lib/auth";

async function handler(req: Request) {
  const auth = getAuth();
  if (!auth) {
    return Response.json(
      { error: "Auth is disabled. Set DATABASE_URL and BETTER_AUTH_SECRET to enable it." },
      { status: 501 },
    );
  }
  return auth.handler(req);
}

export { handler as GET, handler as POST };
```

### 1.5 RLS rewrite: vanilla Postgres, no `auth.uid()`

Move `infra/supabase/migrations/` → `infra/migrations/` (`git mv`), update
`packages/db/drizzle.config.ts` (`out: "../../infra/migrations"`), then run
`pnpm --filter @specboard/db generate` to emit the auth-tables migration.

In `0001_rls_policies.sql`, replace the Supabase-provided `auth.uid()` with a
transaction-local session variable the app sets:

```sql
-- was: and m.user_id = auth.uid()
and m.user_id = current_setting('app.user_id', true)::uuid
```

The app (or a future request-scoped db helper in `packages/db`) sets it per
transaction:

```sql
select set_config('app.user_id', '<session user uuid>', true);
```

**Caveat:** RLS does not apply to the table owner / superuser. The compose
stack connects as `postgres`, which bypasses RLS. That's fine for
single-workspace self-host, but the SaaS must connect as a non-owner role. Add a
`specboard_app` role grant migration when wiring the SaaS connection.

### 1.6 Environment variables

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres; absent = local file mode, auth disabled |
| `BETTER_AUTH_SECRET` | session/signing secret (`openssl rand -hex 32`); also the key that encrypts stored GitHub App credentials at rest |
| `BETTER_AUTH_URL` | canonical app URL (needed behind Fly's proxy); also the public origin used for GitHub manifest callback URLs |
| `APP_URL` | optional override for the public origin (falls back to `BETTER_AUTH_URL`, then forwarded headers) |

GitHub App credentials are normally created in-app (the manifest flow) and
stored **encrypted in the `github_app` table**. No env vars required. The
following are an optional fallback for air-gapped/scripted setups (stored creds
take precedence when both exist):

| Var | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY` | App PEM (literal `\n` escapes are unfolded at load) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `X-Hub-Signature-256` verification |
| `NEXT_PUBLIC_GITHUB_APP_SLUG` | App slug for the install URL (read server-side) |

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` disappear.

### 1.7 Docs & comments sweep

- `ARCHITECTURE.md`: deployment section becomes "SaaS: Fly.io Machines
  (`infra/web.Dockerfile`) + Fly Postgres; auth via Better Auth
  in-app"; fix the other Supabase mentions (lines 48, 62, 66, 85, 101, 123).
- `README.md`: layout entry for `infra/`, the Database section's
  `infra/supabase/migrations` path, and the status line ("Supabase auth"
  → "auth (Better Auth) being wired").
- `infra/docker-compose.yml` header comment; `packages/db/src/client.ts` and
  `apps/web/src/lib/store/db.ts` comments.
- `docs/PLAN.md`: amendment note pointing here (done alongside this doc).

---

## Phase 2: Fly.io setup (terminal / `flyctl`)

> **Executed 2026-06-12**, with one amendment to the shape below: two
> environments instead of one, both in the **specboard** Fly org, region
> `sjc` (MPG is not offered in `sea`):
>
> | Env | Fly app | Domain | Postgres (MPG, basic plan) | Deploys |
> | --- | --- | --- | --- | --- |
> | test | `specboard-test` | test.specboard.ai | `specboard-db-test` | every push to `main` (GitHub Actions) |
> | production | `specboard` | app.specboard.ai | `specboard-db` | manual `workflow_dispatch` after verifying on test |
>
> Configs: `fly.toml` (prod) and `fly.test.toml` at the repo root;
> pipeline: `.github/workflows/fly-deploy.yml` (deploy tokens stored as the
> `FLY_API_TOKEN_TEST` / `FLY_API_TOKEN_PROD` repo secrets). The RLS file
> (`0001_rls_policies.sql`) is **not** applied to either MPG database. It
> still uses Supabase's `auth.uid()` and is rewritten in Phase 1 (1.5),
> which remains unexecuted.
>
> **Superseded 2026-06-29:** the two MPG clusters below were destroyed and
> replaced by legacy Fly Postgres apps (`specboard-prod-db`,
> `specboard-test-db`). The `fly mpg ...` commands in this Phase 2 block are
> kept as a historical record; for the current setup and provisioning recipe
> see "Operational reference (as deployed)" at the end of this doc.

```bash
# 1. Install + sign in
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app from the existing Dockerfile (no deploy yet).
#    Run from the repo root; say no to Postgres/Redis prompts; DB comes next.
fly launch --no-deploy --name specboard --dockerfile infra/web.Dockerfile

# 3. Managed Postgres (MPG): pick the same region as the app
fly mpg create --name specboard-db
# grab the connection string it prints (or: fly mpg status / fly mpg connect)

# 4. Secrets
fly secrets set \
  DATABASE_URL='postgres://...' \
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  BETTER_AUTH_URL='https://specboard.fly.dev'

# 5. Apply migrations from your machine through the MPG proxy
fly mpg proxy &   # local port forward to the managed Postgres
DATABASE_URL='postgres://...localhost...' pnpm db:migrate
# then apply infra/migrations/0001_rls_policies.sql via psql

# 6. Deploy
fly deploy
```

Expected `fly.toml` shape (commit it as `fly.toml` at the repo root, or
`infra/fly.toml` with `fly deploy -c infra/fly.toml`):

```toml
app = "specboard"
primary_region = "sea"   # pick the region adjacent to the DB

[build]
  dockerfile = "infra/web.Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0   # raise to 1+ once webhooks land (cold starts drop deliveries' latency budget)

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Notes:
- `fly mpg` is Fly's first-party Managed Postgres (the old `fly postgres` /
  Supabase partnership is deprecated, so don't use those docs).
- The GitHub App webhook URL (spec-import / webhook-reconcile work) will be
  `https://specboard.fly.dev/api/webhooks/github`; set `min_machines_running = 1`
  before going live with webhooks.
- A future remote MCP server can ship as a second process group in the same
  app (`[processes]`) or its own Fly app.

---

## Phase 3: Verification

> **Executed 2026-06-12**, against the live test environment
> (test.specboard.ai) rather than local compose: build/typecheck/test green;
> board + `/api/v1` list/detail/404/422 verified; gmail.com sign-up rejected
> 400; work-domain sign-up created `users`/`sessions` rows (UUID ids minted
> by Postgres); metadata PATCH persisted. Production (app.specboard.ai)
> verified the same way after promote, minus the user-creating sign-up.
> Items 4 (RLS as non-owner) and 5 (compose boot) were **not** exercised.
> RLS verification needs the `specboard_app` role (next steps), and compose
> parity wasn't re-tested this round.

1. `pnpm build && pnpm typecheck && pnpm test`: green.
2. Local, no `DATABASE_URL`: app runs in file mode; `GET /api/auth/session`
   returns the 501 "auth disabled" response.
3. Local, with compose Postgres + migrations: sign-up round-trip via
   `curl -X POST localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' -d '{"email":"t@t.dev","password":"...","name":"T"}'`
   creates `users` + `accounts` + `sessions` rows.
4. RLS: as a non-owner role with `app.user_id` unset, `select * from features`
   returns zero rows; with `set_config('app.user_id', <member uuid>, true)`,
   the member's workspace rows appear.
5. `docker compose -f infra/docker-compose.yml up` still boots (self-host
   parity, auth disabled).
6. On Fly: `fly deploy` succeeds, the boards are served, sign-up round-trip
   works against the Postgres backend.

## Next steps

Rough priority order; the first three unblock real multi-user usage.

1. ~~**Sign-in / sign-up UI + session-gated writes.**~~ **Done 2026-06-13.**
   `/sign-in` + `/sign-up` pages (`components/auth-form.tsx`) backed by a
   Better Auth browser client (`lib/auth-client.ts`); a session-aware account
   control in the header (`components/account-control.tsx`). Writes go through
   `requireWriteAccess` (`lib/auth-session.ts`), which 401s
   `PATCH /api/v1/*` when auth is enabled and no session is present, and stays
   open in local file mode (auth disabled). Still open: the metadata form
   surfaces the 401 as an inline error rather than redirecting to `/sign-in`.
2. ~~**Workspace bootstrap on first sign-up**~~ **Done 2026-06-13.** One
   workspace per deployment (the "organization"). The first signed-in user with
   no workspace is routed to `/setup` to name the org and is made `admin`
   (`POST /api/v1/workspaces` → `createWorkspaceWithOwner`); every later user is
   auto-joined as `viewer` by `ensureMembership` (`lib/workspace.ts`), invoked
   from the page-access gate `requireWorkspaceAccess` (`lib/workspace-access.ts`)
   which now fronts the backlog/board/roadmap/feature pages. Membership is
   resolved on first authenticated access rather than via a Better Auth hook.
   That keeps one code path, and the post-signup redirect hits it immediately.
   Pages stay ungated in local file mode. Still open: assigning richer roles
   (`pm`/`ux`/`eng`) and an admin UI to manage members. Everyone past the first
   is a `viewer` today.
3. **DB-enforced tenant isolation.** _App-layer half done 2026-06-13:_ every
   tenant query now runs through a `WorkspaceScope` (`store/types.ts`). The
   `DbStore` filters by `workspaceId` and sets `app.user_id` inside a
   transaction (`store/db.ts`), and reads/writes are authorized by membership +
   role (`resolveReadScope` / `authorizeWrite` in `lib/auth-session.ts`;
   `viewer` is read-only via `canWrite`). This gives real isolation in the app
   even though the connection still bypasses RLS. _DB role provisioned on both
   MPG clusters 2026-06-13:_ a non-owner `writer` user **`specboard-app`** (not
   the SQL `create role` in a journaled migration: that role is MPG-specific
   and self-host runs as the superuser-owner, so it lives as an ops step, see
   the operational reference). RLS was verified on both clusters as that role
   (`app.user_id` unset → 0 rows; member → workspace rows; non-member → 0). The
   app reads tenant data via `DATABASE_URL_APP` (the writer) when set, falling
   back to `DATABASE_URL` (owner) otherwise (`store/index.ts`); onboarding/auth
   stay on the owner connection (`lib/db.ts`), since `createWorkspaceWithOwner`
   / `ensureMembership` are default-denied under RLS. The `DATABASE_URL_APP`
   secret is **staged** on both Fly apps. _Remaining:_ deploy the
   `store/index.ts` change (test auto-deploys on push to `main`; prod via the
   manual "Fly Deploy" workflow), then RLS enforces at the DB on the runtime
   path and verification item 4 above is exercised live.
4. ~~**Flip `requireEmailVerification`.**~~ **Code done 2026-06-13.**
   `requireEmailVerification: true` + `autoSignInAfterVerification: true` in
   `lib/auth.ts`; `auth-form.tsx` now shows a "check your email" state with a
   resend affordance after sign-up (and after an unverified sign-in's 403)
   rather than pushing into an app with no session. _Still blocked on owner
   action:_ verify the specboard.ai Postmark sender domain (DKIM + Return-Path
   CNAMEs, off the sandbox server) so the links actually deliver. _Security
   note:_ until delivery works, an unverified work-domain sign-up can no longer
   complete sign-in, but don't bootstrap production until mail is flowing.
5. ~~**GitHub App sync.**~~ **Code done 2026-06-13.** `packages/git` is
   implemented: `GitHubRepoClient` (tree/blob read, contents-API direct commit,
   branch+PR write) in `github.ts`; HMAC signature verification, picomatch glob
   matching, and push-event parsing in `webhook.ts`; pure-function tests in
   `git.test.ts`. Wired into the web app: `POST /api/webhooks/github` verifies
   the signature and reconciles a connected repo's specs into `features` +
   `spec_index` (owner connection, `blobSha` drift-skip); `GET/POST
   /api/v1/repositories` lists/registers repos (admin-only, runs an initial
   import). Each sync reads `.specboard/config.yml` from the repo (via the App)
   and stores the parsed `RepoConfig` on the `repositories` row, so spec globs
   and custom-field definitions track git. Production already runs
   `min_machines_running = 1` so deliveries won't hit cold starts.
   **Done 2026-06-14, in-app one-click setup:** admins create the deployment's
   GitHub App via the **manifest flow** (`/api/v1/github/app/create` →
   `/callback`), credentials stored encrypted in `github_app` (AES-256-GCM off
   `BETTER_AUTH_SECRET`); the env `GITHUB_*` vars are now an optional fallback.
   The **Repositories** page handles App setup, install (`/api/v1/github/setup`
   captures the installation), a repo **picker**
   (`/api/v1/github/installations/repositories`), and connect/re-sync. The old
   curl registration is now an advanced fallback. See `docs/RUNBOOK-github-sync.md`.
   _Still open (follow-up):_ handling spec **deletion** (a removed file currently
   leaves its feature row to avoid nuking user comments/metadata), and editing
   spec content from the UI (PR write-back).
6. ~~**First-run onboarding choice.**~~ **Done 2026-06-13.** `/setup` now asks
   the first user to either seed a starter board (sample data baked into the app
   via `lib/sample-data.ts`, seeded into a synthetic "sample" repo) or start empty;
   `POST /api/v1/workspaces` takes `seedSampleData` and only seeds when the
   caller actually became admin. The board/backlog/roadmap render a shared
   `EmptyState` (prompting a repo connection) when there are no features, and the
   header nav is hidden from signed-out visitors.
7. ~~**Assignee + custom-field editing.**~~ **Done 2026-06-13.** The metadata
   form (`feature-meta-form.tsx`) now edits the assignee (from workspace members)
   and any config-defined custom fields; `parseFeaturePatch` validates
   `assigneeId`/`customFields`, the stores read/write them, and field definitions
   come from the synced `RepoConfig.fields`. _Still open:_ richer roles
   (`pm`/`ux`/`eng`) and a member-management UI. Everyone past the first user is
   still a `viewer`.
8. **Remote MCP server:** second process group in the Fly apps or its own
   app; should consume `/api/v1` (or the shared service layer), not the DB
   directly.
9. ~~**Cost check-in:** two MPG basic clusters run $76/mo.~~ **Done 2026-06-29.**
   Both environments moved off MPG onto legacy Fly Postgres (~$3/mo each), a
   ~$75/mo cut, keeping the two-role RLS model. Tradeoff: unmanaged, single
   node, no automated backups yet. Promote prod to a managed/HA tier before real
   customer data lands. See the Operational reference below.
10. SSO/SAML/SCIM (commercial tier). Better Auth has plugins for this later.

### Operational reference (as deployed)

> **DB platform changed 2026-06-29:** both environments moved off Fly Managed
> Postgres (MPG Basic, ~$38/mo each) onto **legacy Fly Postgres** (Repmgr
> "flex", PG 17.2, single-node `shared-cpu-1x`/512MB + 1GB volume, ~$3/mo each)
> to cut the pre-launch bill ~$75/mo. The RLS two-role model was preserved
> exactly. Caveat: legacy Fly Postgres is unmanaged (single node, no automatic
> failover) and **automated backups are not yet enabled**; a one-time
> pre-cutover dump and the DB credentials live in
> `~/specboard-fly-db-migration-2026-06-29/`. Promote prod to a managed/HA tier
> before real customer data lands.

| | test | production |
| --- | --- | --- |
| URL | https://test.specboard.ai | https://app.specboard.ai |
| Fly app (org `specboard`) | `specboard-test` | `specboard` |
| Postgres app (sjc, flex PG 17) | `specboard-test-db`, db `specboard_test` (seeded from repo specs) | `specboard-prod-db`, db `specboard_prod` |
| DB roles | owner `specboard_owner` + non-owner `specboard_app` (group `writer`) | same |
| Deploy | auto on push to `main` | GitHub Actions → "Fly Deploy" → run workflow → `production` |
| Email | Postmark (test server token) | Postmark (prod server token) |

Secrets per app: `DATABASE_URL` (owner `specboard_owner`: migrations, auth,
onboarding; bypasses RLS as the table owner), `DATABASE_URL_APP` (non-owner
`specboard_app` in group `writer`: RLS-enforced tenant reads/writes),
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS=true`, `POSTMARK_SERVER_TOKEN`,
`EMAIL_FROM`. The flex superuser + role passwords are in
`~/specboard-fly-db-migration-2026-06-29/CREDENTIALS.txt` (shown only at cluster
creation; not recoverable from Fly afterward). DB migrations are applied from a
workstation via `fly proxy 15432:5432 -a <pg-app>` + `pnpm db:migrate` as the
owner (no release command yet).

**Provisioning the roles (per Postgres app).** Not a journaled migration:
self-host runs as a single superuser-owner, so this lives as an ops step. After
`fly postgres create -o specboard -r sjc -n <pg-app> --vm-memory 512
--volume-size 1 --initial-cluster-size 1`, open `fly proxy 15432:5432 -a <pg-app>`
and connect as the `postgres` superuser:

```bash
# 1. Owner (runs migrations, owns tables, bypasses RLS) + non-owner writer login.
psql "$SUPER" <<'SQL'
create role specboard_owner login password '<owner-pw>';
create role writer nologin;
create role specboard_app login password '<app-pw>' in role writer;
create database specboard_prod owner specboard_owner;   -- specboard_test for test
SQL

# 2. In the new DB: owner controls the schema, writer may connect + use it.
psql "$SUPER (dbname=specboard_prod)" <<'SQL'
alter schema public owner to specboard_owner;
grant connect on database specboard_prod to writer;
grant usage on schema public to writer;
SQL

# 3. Run migrations as the owner (creates the schema incl. 0002 RLS).
DATABASE_URL='postgres://specboard_owner:<owner-pw>@localhost:15432/specboard_prod?sslmode=disable' \
  pnpm db:migrate

# 4. As the owner, grant the writer DML on the RLS-protected tables only
#    (auto-discovered) plus future tables and sequences.
psql "$OWNER (dbname=specboard_prod)" <<'SQL'
do $$ declare r record; begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='r' and c.relrowsecurity loop
    execute format('grant select,insert,update,delete on public.%I to writer', r.relname);
  end loop; end $$;
grant usage, select on all sequences in schema public to writer;
alter default privileges for role specboard_owner in schema public
  grant select,insert,update,delete on tables to writer;
alter default privileges for role specboard_owner in schema public
  grant usage, select on sequences to writer;
SQL

# 5. Wire both connection strings into the consuming app (internal flycast host).
fly secrets set -a <app> \
  DATABASE_URL='postgres://specboard_owner:<owner-pw>@<pg-app>.flycast:5432/specboard_prod?sslmode=disable' \
  DATABASE_URL_APP='postgres://specboard_app:<app-pw>@<pg-app>.flycast:5432/specboard_prod?sslmode=disable'
```

Verify (as `specboard_app`): `app.user_id` unset → 0 rows; set to a member's
uuid via `select set_config('app.user_id','<uuid>',true)` in a transaction →
only that workspace's rows; non-member → 0. The owner (`specboard_owner`)
bypasses RLS, so migrations/auth/onboarding keep working.
