# Plan — Multi-tenant org provisioning (ADR-0001 Phase 4-lite)

- **Status:** In progress
- **Branch:** `feat/org-provisioning` (off `main`)
- **Related:** ADR-0001 (multi-tenancy), `feat/github-app-hosting-model` (shared GitHub App for hosted)

## Goal

Enable **true SaaS multi-org** on the hosted deployments: a new account that
signs up gets its **own** workspace/org (its own `/{slug}/…` space), instead of
being auto-joined to the single existing workspace. This is the "org
provisioning" slice the ADR deferred to Phase 4.

Single-tenant / self-host behavior (`SPECBOARD_MULTI_TENANT` unset) must stay
**byte-for-byte unchanged**. Every new behavior is gated on `isMultiTenant()`.

## Why this is needed (current blockers)

The schema + routing are already multi-tenant (Phases 1–3 done). Three N=1
conveniences still force one org per deployment:

1. `createWorkspaceWithOwner` (`apps/web/src/lib/workspace.ts`) — if any
   workspace exists, it returns that one instead of creating a new org.
2. `ensureMembership` — auto-joins every authenticated user to the first
   workspace as `viewer`.
3. `/setup` + `resolveActiveWorkspace`(no slug) + root `/` — key off "a
   workspace exists" rather than "this user has a membership."

## Decisions

- **Slug:** auto-derive from the org name (`slugify`). On **collision** (or a
  reserved slug), do **not** silently append `-2`; instead return a clear
  conflict to the setup form so the user can pick a different name/slug. The
  form surfaces a warning and offers an editable slug prefilled with a
  suggestion.
- **One org per user (MVP):** a user with an existing membership can't create a
  second org (keep the `409` in `POST /api/v1/workspaces`). Multi-org-per-user
  via invites is later.
- **No domain-based auto-join** in this slice. Each new user creates their own
  org. (Email-domain anchoring / invites = future.)

## Work items

### 1. Slug helpers (isomorphic) — `apps/web/src/lib/org-path.ts`
- `slugifyOrg(name): string` — pure, shared by client preview + server.
- `RESERVED_ORG_SLUGS: Set<string>` — top-level literal routes that must never be
  an org slug: `api`, `setup`, `sign-in`, `sign-up`, `forgot-password`,
  `reset-password`, `_next`, `favicon.ico`, plus `LOCAL_ORG_SLUG` (`local`).
- `isReservedOrgSlug(slug): boolean`.

### 2. Workspace creation — `apps/web/src/lib/workspace.ts`
- `createWorkspaceWithOwner`: in MT mode, **always** create a new workspace +
  make the caller `admin` (no "return existing"). Derive slug via `slugifyOrg`;
  reject reserved; on unique-violation/collision throw a typed
  `SlugTakenError` (carry a suggested free slug). Single-tenant: unchanged.
- Add an explicit-`slug` parameter path so the form can submit a chosen slug.
- `ensureMembership`: in MT mode, **no auto-join** — return the caller's existing
  membership or `null`.
- `resolveActiveWorkspace`(no slug): in MT mode, resolve from the caller's actual
  memberships (single → it; none → `null`); never auto-join.

### 3. API — `apps/web/src/app/api/v1/workspaces/route.ts`
- Accept optional `slug` in the body.
- Map `SlugTakenError` → `409 { error, code: "slug_taken", suggestion }`.
- Map reserved/invalid slug → `422 { error, code: "slug_invalid" }`.
- Keep "already belongs → 409".

### 4. Setup flow — `apps/web/src/app/setup/page.tsx` + `components/setup-form.tsx`
- Page guard (MT): show the form when **this user** has no membership; redirect
  to their org only if they already belong to one. Single-tenant: unchanged
  ("if any workspace exists, join + leave").
- Form: live slug preview ("Your URL: …/{slug}"). On `slug_taken`/`slug_invalid`,
  show a warning and reveal an editable slug field prefilled with the suggestion.

### 5. `api-client.ts`
- `createWorkspace(name, seedSampleData, slug?)` → returns `{ slug }`; surface
  the conflict `code`/`suggestion` so the form can react.

### 6. Tests
- New org created (not joined) in MT mode; auto-join still happens single-tenant.
- Slug collision → conflict (no silent dedupe).
- Reserved slug rejected.
- `resolveActiveWorkspace` no-slug: returns existing membership / null, no
  auto-join in MT.

## Out of scope (follow-ups)

- Org switcher UI (each test account is in one org; `listMembershipsForUser`
  already exists).
- Invites / email-domain auto-join; org-scoped API tokens; billing/seat limits.

## Rollout (after merge + deploy)

1. Merge this + `feat/github-app-hosting-model` → auto-deploys test.
2. Flip `SPECBOARD_MULTI_TENANT=true` on **test**; verify a second account
   creates its own org and `palouse` still resolves.
3. In GitHub, set the test App `specboard-studiopalouse` to **Any account** so
   other orgs can install it; verify the second org connects a repo.
4. Prod: register the shared `SpecBoard` App as `@specboard` ("Any account"),
   set its env secrets + `SPECBOARD_MULTI_TENANT=true` on `specboard`.

## Environment facts (captured 2026-06-20)

- test (`specboard-test`, db `z7y24od8vemrgqd1`): 1 workspace `palouse`, 1 member,
  1 repo. Stored App `specboard-studiopalouse` (app_id 4052836, StudioPalouse,
  `public:false`). Flag unset.
- prod (`specboard`, db `1zqyxr7d791rwp8m`): 1 workspace `nintex`, 1 member, 0
  repos. No GitHub App, no GitHub env. Flag unset.
</content>
</invoke>
