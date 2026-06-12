# Migration Plan — Fly.io Hosting + Better Auth (drop Supabase)

**Status: executed 2026-06-12** (Phases 1–3 complete; see [Next steps](#next-steps)
for what remains). Amends the stack decision in [`PLAN.md`](./PLAN.md) and the
deployment section of [`ARCHITECTURE.md`](../ARCHITECTURE.md).

Landed beyond the original scope of this plan, same date:

- **Consumer email-domain blocking** — sign-ups from gmail/outlook/yahoo/etc.
  are rejected when `SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS` is truthy
  (helper + list in `@specboard/core`, hook in `apps/web/src/lib/auth.ts`).
  On for both Fly apps, off by default for self-host.
- **Versioned API layer** — `GET /api/v1/features`,
  `GET`/`PATCH /api/v1/features/:specId` (`lib/features-service.ts`); all UI
  mutations go through it (`lib/api-client.ts`), server actions removed.
- **Postmark email delivery** — `lib/email.ts` posts to Postmark's HTTP API;
  Better Auth verification + password-reset emails. No-op with a logged
  warning when `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM` are unset.
- The RLS policies became a **journaled** drizzle migration
  (`infra/migrations/0002_rls_policies.sql`) instead of a manual psql step —
  `pnpm db:migrate` applies the entire chain.

## Decision & rationale

- **Hosting (SaaS):** Fly.io Machines running the existing
  `infra/web.Dockerfile` — the hosted product runs the *same image*
  self-hosters run via docker-compose (strong open-core parity). Fly also
  handles the long-lived processes we need later (webhook reconciler, remote
  MCP server over streamable HTTP/SSE) that serverless platforms make awkward.
- **Database (SaaS):** plain managed Postgres — Fly Managed Postgres (MPG).
  The Supabase↔Fly partnership was deprecated April 2025, and depending on
  Supabase-specific features (Auth, `auth.uid()` in RLS) would have forced
  self-hosters to run the full Supabase stack or forked the auth code path.
- **Auth:** [Better Auth](https://better-auth.com) — a TypeScript library that
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

Self-host is **already** plain Postgres via docker-compose — nothing changes
for self-hosters except auth becoming available to them (it was previously
planned as Supabase/SaaS-only).

---

## Phase 1 — Code changes (repo)

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

### 1.3 Better Auth server instance — `apps/web/src/lib/auth.ts`

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

### 1.4 Route handler — `apps/web/src/app/api/auth/[...all]/route.ts`

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

### 1.5 RLS rewrite — vanilla Postgres, no `auth.uid()`

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
stack connects as `postgres`, which bypasses RLS — fine for single-workspace
self-host, but the SaaS must connect as a non-owner role. Add a
`specboard_app` role grant migration when wiring the SaaS connection.

### 1.6 Environment variables

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres; absent = local file mode, auth disabled |
| `BETTER_AUTH_SECRET` | session/signing secret (`openssl rand -hex 32`) |
| `BETTER_AUTH_URL` | canonical app URL (needed behind Fly's proxy) |

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` disappear.

### 1.7 Docs & comments sweep

- `ARCHITECTURE.md`: deployment section becomes "SaaS: Fly.io Machines
  (`infra/web.Dockerfile`) + Fly Managed Postgres; auth via Better Auth
  in-app"; fix the other Supabase mentions (lines 48, 62, 66, 85, 101, 123).
- `README.md`: layout entry for `infra/`, the Database section's
  `infra/supabase/migrations` path, and the status line ("Supabase auth"
  → "auth (Better Auth) being wired").
- `infra/docker-compose.yml` header comment; `packages/db/src/client.ts` and
  `apps/web/src/lib/store/db.ts` comments.
- `docs/PLAN.md`: amendment note pointing here (done alongside this doc).

---

## Phase 2 — Fly.io setup (terminal / `flyctl`)

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
> (`0001_rls_policies.sql`) is **not** applied to either MPG database — it
> still uses Supabase's `auth.uid()` and is rewritten in Phase 1 (1.5),
> which remains unexecuted.

```bash
# 1. Install + sign in
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app from the existing Dockerfile (no deploy yet).
#    Run from the repo root; say no to Postgres/Redis prompts — DB comes next.
fly launch --no-deploy --name specboard --dockerfile infra/web.Dockerfile

# 3. Managed Postgres (MPG) — pick the same region as the app
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
  Supabase partnership is deprecated — don't use those docs).
- The GitHub App webhook URL (spec-import / webhook-reconcile work) will be
  `https://specboard.fly.dev/api/webhooks/github`; set `min_machines_running = 1`
  before going live with webhooks.
- A future remote MCP server can ship as a second process group in the same
  app (`[processes]`) or its own Fly app.

---

## Phase 3 — Verification

> **Executed 2026-06-12**, against the live test environment
> (test.specboard.ai) rather than local compose: build/typecheck/test green;
> board + `/api/v1` list/detail/404/422 verified; gmail.com sign-up rejected
> 400; work-domain sign-up created `users`/`sessions` rows (UUID ids minted
> by Postgres); metadata PATCH persisted. Production (app.specboard.ai)
> verified the same way after promote, minus the user-creating sign-up.
> Items 4 (RLS as non-owner) and 5 (compose boot) were **not** exercised —
> RLS verification needs the `specboard_app` role (next steps), and compose
> parity wasn't re-tested this round.

1. `pnpm build && pnpm typecheck && pnpm test` — green.
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
   works against MPG.

## Next steps

Rough priority order; the first three unblock real multi-user usage.

1. **Sign-in / sign-up UI + session-gated writes.** Auth endpoints exist but
   there is no browser way to authenticate. Add the pages, then gate
   `PATCH /api/v1/*` (and future write routes) on
   `getAuth().api.getSession({ headers })` — today writes are open, matching
   the pre-auth behavior.
2. **Workspace bootstrap on first sign-up** — create workspace + admin
   `members` row; until then signed-up users own nothing and the prod board
   stays empty (its DB is migrated but intentionally unseeded).
3. **`specboard_app` non-owner DB role** so RLS actually enforces on the SaaS
   (the app currently connects as the table owner, which bypasses RLS), plus
   a request-scoped db helper that runs `set_config('app.user_id', …, true)`
   per transaction. Then run verification item 4 above.
4. **Flip `requireEmailVerification`** in `lib/auth.ts` once the Postmark
   sender domain (specboard.ai DKIM + Return-Path DNS) is verified.
5. **GitHub App sync** (`packages/git` is still stubbed): webhook endpoint
   `/api/webhooks/github`; before going live, production already runs
   `min_machines_running = 1` so deliveries won't hit cold starts.
6. **Remote MCP server** — second process group in the Fly apps or its own
   app; should consume `/api/v1` (or the shared service layer), not the DB
   directly.
7. **Cost check-in:** two MPG basic clusters run $76/mo. If that's heavy
   pre-launch, both environments can share one cluster (~$38/mo) with
   separate databases — revisit before the bill matters.
8. SSO/SAML/SCIM (commercial tier) — Better Auth has plugins for this later.

### Operational reference (as deployed)

| | test | production |
| --- | --- | --- |
| URL | https://test.specboard.ai | https://app.specboard.ai |
| Fly app (org `specboard`) | `specboard-test` | `specboard` |
| MPG cluster (sjc, basic) | `specboard-db-test` (seeded from repo specs) | `specboard-db` (empty) |
| Deploy | auto on push to `main` | GitHub Actions → "Fly Deploy" → run workflow → `production` |
| Email | Postmark (test server token) | Postmark (prod server token) |

Secrets per app: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS=true`, `POSTMARK_SERVER_TOKEN`,
`EMAIL_FROM`. DB migrations are applied from a workstation via
`fly mpg proxy <cluster-id>` + `pnpm db:migrate` (no release command yet).
