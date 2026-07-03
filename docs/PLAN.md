# Specboard: Architecture & Initial Scaffold

## Context

The team is moving to **spec-driven development**: AI agents write code from specs that
live in the git repo. But the people who *own* the backlog and feature definition (PM
and UX) don't want to edit specs through the VS Code terminal against GitHub. The team
needs a lightweight, collaborative product-management layer that:

- Lets PM prioritize a backlog and lets PM/UX/Eng collaborate on feature definition.
- Integrates the **"feature" directly with the spec in the repo** (no duplicate authoring).
- Layers **metadata** (status, assignment, priority, tags, roadmap) *on top* of those specs.
- Is essentially a lightweight, spec-based ProductBoard / JIRA / Aha!, giving visibility
  without duplicate effort across systems.
- Ships as **open-core self-hosted** *and* a **hosted SaaS** for teams that don't want to self-host.

The reference project `spec-board/spec-board` was rejected because it centralizes specs in
Postgres, losing git as the source of truth. GitHub **Spec Kit** is git-native but CLI-only
with no PM layer. JIRA/Aha are heavyweight and disconnected from the actual specs. Specboard
fills the gap.

> **Amendment (2026-06-12):** the Supabase + Vercel decision below is
> superseded. The hosted SaaS will run on Fly.io with plain Postgres,
> and auth moves to Better Auth (in-app, works identically for self-host).
> Details and execution steps: [`PLAN-fly-better-auth.md`](./PLAN-fly-better-auth.md).
>
> **Executed later the same day:** both Fly environments are live
> (test.specboard.ai auto-deploys from `main`; app.specboard.ai promotes via
> manual workflow dispatch), with Better Auth endpoints, consumer
> email-domain blocking, a versioned `/api/v1` layer, and Postmark email.
> Current next steps live in that doc's [Next steps] section.
>
> **Amendment (2026-06-19):** multi-tenancy and the work hierarchy are now
> governed by ADRs: [`adr/0001`](./adr/0001-multi-tenancy-url-and-product-grouping.md)
> (one codebase, always multi-tenant; `/{org}/{product}/` URL prefix; products as
> DB groupings) and [`adr/0002`](./adr/0002-work-item-leaf-and-typed-item-urls.md)
> (default hierarchy Initiative → Epic → Feature → Work Item with only the leaf
> spec-backed; type-segmented item URLs `/{org}/{product}/backlog/{level}/{specId}`).

### Decisions locked with the user
- **Source of truth:** spec **content lives in git** (canonical); **metadata lives in the DB**,
  linked to specs by a stable spec ID.
- **Deliverable (this effort):** comprehensive `ARCHITECTURE.md` **+ a monorepo scaffold**
  (package boundaries, frameworks, stubbed services). No working features yet.
- **Stack:** Next.js + TypeScript full-stack. Data/auth layer = **Supabase** (Postgres + Auth +
  RLS), confirmed available via the connected Supabase MCP in this session.
- **Open-core line:** core OSS (spec editing, boards/kanban, git sync, MCP server, single-org
  self-host). Commercial SaaS-only features (multi-tenant hosting, SSO/SAML/SCIM, advanced
  roadmap/analytics, premium integrations, audit logs).

---

## Core Architectural Model

```
        ┌──────────────── GitHub repo (source of truth for SPEC CONTENT) ────────────────┐
        │  specs/<feature-slug>/spec.md  (frontmatter: id, title)                          │
        │                       plan.md / design.md / tasks.md                             │
        │  .specboard/config.yml  (which dirs are specs, status vocab, field schema)       │
        └───────────────▲───────────────────────────────┬─────────────────────────────────┘
                        │ commits / PRs (write)          │ webhooks + reads (pull)
                        │                                 ▼
              ┌─────────┴─────────────────────────────────────────────┐
              │            Git Integration Service (GitHub App)         │
              │  read specs · parse frontmatter · webhook reconcile ·   │
              │  write edits back as commits/PRs                        │
              └─────────┬───────────────────────────────────┬──────────┘
                        │ spec content + sha (cache/index)   │
                        ▼                                     ▼
   ┌─────────────────────────────────┐        ┌───────────────────────────────────┐
   │   Postgres (Supabase)            │        │   Next.js Web App                  │
   │   METADATA = system of record:   │◄──────►│   Backlog · Kanban boards ·        │
   │   status, assignee, priority,    │        │   Roadmap · Spec editor (Markdown) │
   │   tags, roadmap, comments        │        │   Feature detail (spec + metadata) │
   │   + spec INDEX (content cache,   │        └───────────────────────────────────┘
   │     git path, sha, spec_id)      │
   │   RLS for multi-tenancy          │        ┌───────────────────────────────────┐
   └─────────────────────────────────┘◄──────►│   MCP Server (specs + metadata to   │
                                               │   coding agents: read/list/update)  │
                                               └───────────────────────────────────┘
```

**Spec identity (the linchpin).** Each spec carries a stable `id` in YAML frontmatter
(`id: <uuid>`, `title:`). The DB metadata row is keyed by `(repo_id, spec_id)`, **not** by
file path, so renames/moves don't orphan metadata. On first import of a spec without an `id`,
the Git Integration Service injects one via a commit (the only metadata that touches git, kept
minimal and intentional). Path + blob `sha` are stored in the index for fast lookup and
drift/conflict detection.

**Why metadata-in-DB works here:** the spec markdown stays diff-able and versioned with code
(agents read it from git); the volatile PM data (status churn, assignment, ordering) stays in a
queryable store with real-time updates and access control. No spec-file thrash from a status flip.

---

## Monorepo Scaffold (to be created)

Turborepo + pnpm workspaces. TypeScript throughout. Drizzle ORM (lightweight, SQL-first, plays
well with Supabase Postgres + generated types).

```
specboard/
├─ apps/
│  ├─ web/                  # Next.js (App Router): UI + server actions/route handlers
│  └─ mcp/                  # MCP server exposing specs + metadata to agents
├─ packages/
│  ├─ core/                 # Domain logic: spec parsing (frontmatter+markdown), field schema,
│  │                        #   prioritization, status state machine, framework-agnostic
│  ├─ db/                   # Drizzle schema, migrations, RLS policies, typed client
│  ├─ git/                  # GitHub App client, spec reader/writer, webhook reconciler
│  └─ ui/                   # Shared React components (board, editor, design tokens)
├─ infra/
│  ├─ docker-compose.yml    # Self-host: web + Postgres (+ optional local Supabase)
│  └─ supabase/             # SaaS: migrations, RLS, auth config
├─ ARCHITECTURE.md          # Full design doc (this plan, expanded)
├─ turbo.json · pnpm-workspace.yaml · tsconfig.base.json
└─ README.md
```

### Data model (DB: metadata + index), defined in `packages/db`
- `workspaces` (tenant root) → `members` (role: pm/ux/eng/admin) → `repositories` (GitHub install + repo).
- `features`, the metadata record: `id`, `workspace_id`, `repo_id`, `spec_id` (matches git
  frontmatter), `level`, `parent_id`, `status`, `assignee_id`, `rank` (backlog ordering),
  `tags[]`, `release_id`, `custom_fields` (jsonb of admin-defined property values),
  `details` (Markdown body for DB-native items), timestamps.
- `workspace_properties` (admin-defined custom card properties), `releases` (ship
  vehicles), `detail_templates` (Markdown skeletons seeding a card's details).
- `spec_index`, cache of spec content: `feature_id`, `path`, `blob_sha`, `content`,
  `parsed` (jsonb: title, sections), `last_synced_at`.
- `comments`, `activity_log`.
- **RLS** scopes every row by `workspace_id`; SaaS = many workspaces, self-host = one.

### Key flows
1. **Import/connect repo:** one-click create the GitHub App (manifest flow, creds
   stored encrypted) → install + pick repos → connect → scan `specs/**` per
   `.specboard/config.yml` → create `features` + `spec_index`, inject missing `id`.
2. **Webhook reconcile:** push to repo → re-parse changed specs → update `spec_index`; detect
   conflicts via `blob_sha`.
3. **Edit spec in UI:** save → `git` package writes a commit (configurable: direct to branch or
   open a PR) → webhook confirms → index updates.
4. **Edit metadata in UI:** writes straight to DB (no git churn), real-time to boards.
5. **Agent via MCP:** `list_features` (with metadata filters), `read_spec`, `update_status`,
   `add_task`. Agents see prioritized, assigned, status-aware specs.

### Open-core boundary (enforced via package/feature flags)
- **OSS (`apps/web`, all `packages/*`):** spec editor, kanban/backlog/roadmap, GitHub git sync,
  MCP server, single-workspace self-host, docker-compose deploy.
- **Commercial (`infra/supabase` + gated modules):** multi-tenant SaaS, SSO/SAML/SCIM, advanced
  analytics/insights, premium integrations (Jira/Linear/Slack), audit logs, managed hosting/support.
- Keep commercial code in clearly separated, flag-gated modules so the OSS build is fully
  functional standalone (avoid crippleware).

---

## Build Steps (for the implementing agents, after this plan is approved)
1. Scaffold Turborepo + pnpm workspace, base tsconfig, lint/format.
2. `packages/core`: spec frontmatter + markdown parser, field-schema types, status state machine.
3. `packages/db`: Drizzle schema + migrations + RLS policies for the model above.
4. `packages/git`: GitHub App client, spec reader/writer, webhook reconciler (stubbed handlers OK).
5. `apps/web`: Next.js shell with Supabase auth, workspace switcher, and stub routes for
   Backlog / Board / Roadmap / Feature detail.
6. `apps/mcp`: MCP server skeleton with `list_features` / `read_spec` / `update_status` stubs.
7. `infra/`: docker-compose (self-host) + supabase migration dir (SaaS).
8. `ARCHITECTURE.md` + `README.md`: expand this plan into the repo's canonical design doc.

> Scaffold = compiling skeleton with typed boundaries and stubbed services; no end-to-end
> feature is wired yet.

---

## Verification
- `pnpm install && pnpm build` (turbo) compiles all packages/apps with no type errors.
- `pnpm --filter @specboard/db migrate` applies cleanly against a local/Supabase Postgres
  (use the Supabase MCP `apply_migration` / `list_tables` to confirm schema + RLS landed).
- `docker compose -f infra/docker-compose.yml up` boots web + Postgres; web shell loads.
- `apps/mcp` starts and lists its tool stubs (`list_features`, `read_spec`, `update_status`).
- Manual: confirm `packages/core` parses a sample `specs/<slug>/spec.md` with frontmatter
  `id`/`title` into the expected structured object (unit test on the parser).
- Sanity-check the open-core boundary: an OSS-only build (commercial modules disabled) still
  builds and boots.

> All work lands on branch `claude/spec-driven-platform-arch-e3xkvb`; commit and push when the
> scaffold builds cleanly. No PR unless requested.
