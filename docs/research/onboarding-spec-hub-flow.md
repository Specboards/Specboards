# Onboarding flow design: Spec Hub

**Status:** Design (for discussion), no code in this doc
**Date:** 2026-06-15
**Companion to:** [`spec-repo-strategy.md`](./spec-repo-strategy.md)

---

## 1. Goal & non-goals

**Goal.** Extend Specboards' onboarding so a new workspace can choose how it wants specs
organized. If it wants the **Spec Hub** model (one repo holds specs + a manifest
pointing at service repos), it should get there with as little manual setup as possible. The flow
should: (a) ask the user what **setup style** they want, (b) **detect** whether they
already have a spec hub, and (c) if not, **offer to create one** by scaffolding hub files
into an existing connected repo.

**Non-goals (this iteration).**
- **Creating a brand-new GitHub repo** from inside Specboards. Our GitHub App today only
  has `contents: write`, `pull_requests: write`, `metadata: read`
  (`apps/web/src/app/api/v1/github/app/create/route.ts`). Creating a repo needs
  `Administration: write`, a permission bump that triggers re-consent for every existing
  install, so we've deferred it until there's demand. We scaffold into a repo the user already
  connected.
- Changing how agents *execute* code across multiple repos. That's downstream of this;
  see the memo. This doc stops at "the hub exists and is registered."
- Migrating existing co-located workspaces. The new style is additive and opt-in.

---

## 2. Where this sits today

Current onboarding is linear and single-step:

```
sign-up → verify email → /setup (org name + "sample data | empty") → /backlog
                                                         ↑ repos connected separately on /repositories
```

(`apps/web/src/app/setup/page.tsx`, `apps/web/src/components/setup-form.tsx`,
`apps/web/src/components/repositories-manager.tsx`.) There is **no stepper/wizard pattern
in the codebase**, so the multi-step shape below is new, but each step reuses an existing
piece rather than inventing one.

---

## 3. Proposed flow

Turn `/setup` into a short, resumable wizard. Steps 1 and 3 already exist as standalone
screens; we're sequencing them and inserting the style choice (2) and hub setup (4).

```
┌── Step 1: Workspace ───────────────────────────────────────────────┐
│ Org name (reuse SetupForm). Sample-data toggle moves to the end.    │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌── Step 2: Setup style ─────────────────────────────────────────────┐
│ ( ) Co-located specs   specs live in each code repo (today's model) │
│ (•) Spec Hub           one repo holds specs + a manifest of service │
│                        repos; agents read here, code work targets   │
│                        the referenced repos                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌── Step 3: Connect GitHub ──────────────────────────────────────────┐
│ Reuse existing App-install + repo-picker flow                       │
│ (repositories-manager.tsx). Needed for both styles.                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                    style == "hub"? ──no──► Step 5
                              │ yes
┌── Step 4: Spec hub ────────────────────────────────────────────────┐
│ Detect existing hub among connected repos.                          │
│  • exactly one found  → "Using <owner>/<repo> as your spec hub."    │
│  • several found      → pick which one                               │
│  • none found         → "Create a spec hub" → pick a connected repo  │
│                          to scaffold into (see §4)                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
┌── Step 5: Finish ──────────────────────────────────────────────────┐
│ Optional sample data; → /backlog                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### State machine

```
workspace ─▶ style ─▶ connect ─┬─(co-located)─────────────────▶ finish
                               └─(hub)─▶ hub_detect ─┬─found───▶ designate ─▶ finish
                                                     └─none────▶ scaffold ──▶ finish
```

Persist progress against the workspace (a small `onboarding_state` value, e.g. on the
workspace row or a settings key) so a refresh or an OAuth round-trip during Step 3 resumes
in place rather than restarting. The wizard must tolerate the GitHub App redirect
(`/api/v1/github/app/callback` → `/repositories?...`) bouncing back into the flow.

---

## 4. "Create a spec hub" = scaffold into an existing repo

When no hub exists and the user picks a connected repo to become one, scaffold three
artifacts using the **existing** `GitHubRepoClient.writeFile` (`packages/git/src/github.ts`),
honoring the repo's `writeMode` (so a `pr`-mode repo gets a PR, a `direct`-mode repo gets a
commit on the default branch):

1. **`.specboards/config.yml`**: extend the existing config with `isSpecHub: true` (see §5):
   ```yaml
   version: 1
   isSpecHub: true
   specGlobs:
     - "specs/**/spec.md"
   writeMode: pr
   ```
2. **`.specboards/manifest.yml`**: the service list with pinned references:
   ```yaml
   version: 1
   services:
     - name: example-service
       owner: acme
       repo: example-service
       ref: v1.0.0        # pinned tag/SHA, not a floating branch
       # path: services/example   # optional sub-path within the repo
   ```
3. **`specs/example/spec.md`**: a starter spec, with a stable `id` injected via the
   existing `injectSpecId` / `reconcileSpecs` (`packages/git/src/index.ts`).

Then run `syncRepository` (`apps/web/src/lib/github-sync.ts`) so the new specs and config
land in `repositories.config` / `spec_index` immediately.

> **UX note:** in `writeMode: pr` the scaffold lands as a *pull request*, so the wizard
> can't assume the files are on the default branch when it finishes. Surface the PR link
> and let the user complete onboarding while the PR is open; mark the repo as the
> intended hub optimistically and reconcile on merge.

---

## 5. Config / schema changes (proposed, not implemented)

Extend `repoConfigSchema` in `packages/core/src/config.ts`:

```ts
// added fields (illustrative)
isSpecHub: z.boolean().default(false),
// manifest lives in its own .specboards/manifest.yml; config just flags the hub
```

A separate `manifestSchema` for `.specboards/manifest.yml`:

```ts
const manifestSchema = z.object({
  version: z.literal(1),
  services: z.array(z.object({
    name:  z.string(),
    owner: z.string(),
    repo:  z.string(),
    ref:   z.string(),            // pinned tag/SHA
    path:  z.string().optional(),
  })).default([]),
});
```

**Storage: reuse `repositories.config` JSONB, no migration.** That column already caches
the parsed `.specboards/config.yml` (`packages/db/src/schema.ts`,
`apps/web/src/lib/github-sync.ts`), so `isSpecHub` rides along for free, and a hub query is
just a JSONB filter. The manifest's service list is read from git (and can be cached the
same way the config is).

*Alternative considered:* explicit `is_spec_hub boolean` + `manifest jsonb` columns on
`repositories`. Cleaner to query, but needs a migration and duplicates state that already
lives in the versioned `.specboards/` files. Prefer JSONB; revisit if hub queries get hot.

---

## 6. Detection logic

A hub = a connected repo whose parsed config has `isSpecHub === true`. To detect during
onboarding, read each workspace repo's config. Prefer the **cached** `repositories.config`
(already synced) and fall back to `readRepoConfigFromGit` (`apps/web/src/lib/github-sync.ts`)
for freshly connected repos not yet synced.

| Repos with `isSpecHub` | Behavior |
|---|---|
| 0 | Offer to create: pick a connected repo to scaffold into (§4) |
| 1 | Auto-designate; show which repo, allow change |
| >1 | Ask the user to pick the active hub; flag the others as a warning (multiple hubs is usually a mistake) |

---

## 7. API surface (proposed)

Sketches only: shapes, not implementations.

- **`GET /api/v1/spec-hubs`**: list hubs detected in the workspace.
  `→ { hubs: [{ repoId, owner, name, manifestServiceCount }] }`
- **`POST /api/v1/spec-hubs`**: designate + (optionally) scaffold.
  `{ repoId, scaffold: true }` → writes config/manifest/starter spec (§4), re-syncs,
  returns `{ repoId, isSpecHub: true, pr?: { url } }`.

Both admin-only, mirroring `POST /api/v1/repositories`
(`apps/web/src/app/api/v1/repositories/route.ts`). Alternatively fold designation into the
existing repositories route with a `role: "hub"` flag; a dedicated route keeps the concern
separate and is preferred.

---

## 8. Agent / MCP implications (brief)

Once a hub is registered, a spec in the hub needs to point code work at the right service
repo(s). The natural shape: a feature references one or more manifest services (e.g. a
`targets` field), and the MCP layer (`apps/mcp/src/server.ts`) exposes that alongside
`read_spec` so an agent reading a hub spec knows which repo(s) to act in. Fully specifying
this is out of scope here. See the memo's "recommendation" and "open questions" sections.

---

## 9. Risks & open questions

- **PR-mode scaffolding:** files arrive via PR, so "the hub is ready" is eventually
  consistent. Need clear UX for the pending-PR state (§4).
- **Private-repo scope:** scaffolding assumes write access to the chosen repo; confirm the
  App install covers it before offering to create.
- **Multiple hubs:** define one active hub per workspace (or allow several explicitly?).
- **Scan cost:** detection across many repos should use cached config, not N git reads.
- **Manifest schema:** `ref` pinning, optional `path`, and how/whether to validate that
  referenced repos are also connected to the workspace.
- **Deferred: create-new-repo.** Revisit the `Administration: write` permission bump if
  users want Specboards to stand up the hub repo itself.

---

## 10. Phased implementation outline

1. **Config & manifest schema:** extend `repoConfigSchema`, add `manifestSchema`
   (`packages/core/src/config.ts`); parse manifest in sync.
2. **Detection API:** `GET /api/v1/spec-hubs` over cached `repositories.config`.
3. **Scaffold API:** `POST /api/v1/spec-hubs` using `writeFile` + `injectSpecId` + re-sync.
4. **Wizard UI:** sequence Steps 1–5, add the style choice and hub step, add resumable
   `onboarding_state`.

Each phase is independently shippable; the model works end-to-end after Phase 3 (a power
user could hand-edit `.specboards/config.yml`), with Phase 4 making it self-serve.
