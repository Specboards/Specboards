# Specboards Architecture

Specboards is a lightweight, spec-based product-management layer for teams doing
**spec-driven development**. Specs live as markdown in your git repo (canonical,
versioned with code, read by AI coding agents). Specboards layers the _product_
metadata **on top** of those specs (status, assignment, backlog order, releases,
admin-defined custom properties, and a rich-text details body) so PM, UX, and
engineering can collaborate without editing files in a terminal and without
duplicating work into a separate tracker.

Think of it as a spec-native, lightweight ProductBoard / JIRA / Aha!.

## Why not just use spec-board / Spec Kit / JIRA?

- **spec-board** centralizes specs in Postgres, giving up git as the source of truth.
- **GitHub Spec Kit** is git-native but CLI-only, with no PM layer, no metadata, and no UI for PM/UX.
- **JIRA / Aha / ProductBoard** are heavyweight and disconnected from the actual specs,
  forcing duplicate authoring and brittle syncs.

Specboards keeps **spec content in git** and **metadata in a database**, joined by a
stable spec id.

## System of record

| Data                                                       | Home         | Why                                                                           |
| ---------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Spec content (`spec.md`, `plan.md`, `tasks.md`)            | **Git**      | Diff-able, versioned with code, read by agents                                |
| Metadata (status, assignee, rank, tags, release, custom properties, details) | **Database** | Queryable, real-time, access-controlled; no spec-file thrash on a status flip |
| Spec index (content cache + git path/sha)                  | **Database** | Fast boards/search without hitting git on every render                        |

### Spec identity: the linchpin

Each spec carries a stable `id` (UUID) in YAML frontmatter. The DB `features` row is
keyed by `(repo_id, spec_id)`, **not** by path, so renames/moves never orphan
metadata. On first import of a spec without an `id`, the git service injects one via a
single commit (`packages/git` → `injectSpecId`). Path + blob `sha` are cached in
`spec_index` for fast lookup and drift/conflict detection.

Only the **leaf** level (Work Item) is spec-backed; the grouping levels above it
(Initiative / Epic / Feature) are **DB-native** rows with no git spec; each takes a
synthetic `spec_id` equal to its row id so every item is uniformly routable. Item
permalinks are type-segmented by level: `/{org}/{product}/backlog/{levelKey}/{specId}`
(the bare `/backlog/{specId}` still redirects). See
[`docs/adr/0002-work-item-leaf-and-typed-item-urls.md`](docs/adr/0002-work-item-leaf-and-typed-item-urls.md).

## Components

```
GitHub repo (specs/**, .specboards/config.yml)
   ▲ commits/PRs        │ webhooks + reads
   │                    ▼
Git Integration Service (GitHub App)  ── packages/git
   reads/parses specs · injects ids · reconciles on push · writes edits back
   │                                   ▲
   ▼ content + sha (index)             │ specs + metadata
Postgres  ── packages/db               │
   metadata (system of record) + spec index + RLS multi-tenancy
   ▲                                   │
   │                                   │
Next.js web app  ── apps/web           MCP server ── apps/mcp
   Backlog · Board · Roadmap ·         list_features · read_spec ·
   Feature detail (spec + metadata     update_status · get_relations
   + dependencies/relations)           (to coding agents)
```

- **`packages/core`** holds framework-agnostic domain logic: spec frontmatter + markdown
  parser (`parseSpec`), status state machine (`canTransition`), `.specboards/config.yml`
  schema (`parseRepoConfig`), and the configurable work-tracking **levels** model
  (`resolveLevels`/`leafLevel`/`parentLevelKey`/`resolveLevelUpdate`, covering depth, the
  spec-backed leaf, and parent/child level rules). Unit-tested.
- **`packages/db`**: Drizzle schema (`workspaces`, `members`, `repositories`,
  `workspace_levels` (per-workspace hierarchy config, default Initiative → Epic →
  Feature → Work Item, where only the leaf is spec-backed; also carries the
  per-level available `card_fields` and a `detail_template_id` default),
  `features` (with a self-referential `parent_id` for the work hierarchy,
  a `level` column composite-FK'd to `workspace_levels`, a nullable `repo_id` for
  DB-native items above the leaf (also `ON DELETE set null`, so disconnecting a
  repo detaches its imported items instead of deleting them), a fractional
  `rank` for manual board ordering, a nullable `release_id` (`ON DELETE set
  null`), a `custom_fields` jsonb map of admin-defined property values, and a
  nullable `details` Markdown body for DB-native items),
  `workspace_properties` (admin-defined custom card properties: key/label/type/
  options and the levels each applies to), `releases` (ship vehicles with a
  status + target date), `detail_templates` (reusable Markdown skeletons that
  seed a new card's details),
  `feature_links` (typed dependencies/relations between features),
  `feature_github_links` (links a feature to a GitHub PR/issue/branch with cached
  state), `spec_index`, `comments`, `activity_log`, `saved_views` (per-user backlog
  filters), `board_preferences` (per-user board card-field choices), the
  deployment-global `github_app` credential row, plus the Better Auth
  `users`/`sessions`/`accounts`/`verifications` tables) + Postgres client. RLS
  policies in `infra/migrations`.
- **`packages/git`**: GitHub App client + reconciler (`reconcileSpecs`), webhook
  verification/affected-spec resolution, installation-repo listing (via `octokit`).
- **`packages/ui`**: shared design tokens / components.
- **`apps/web`**: Next.js App Router UI; left sidebar nav with light/dark theme;
  in-app auth via Better Auth (`/api/auth/*`: sign-up/in, email verification,
  password reset), with an optional sign-up-code gate
  (`SPECBOARDS_SIGNUP_CODE_REQUIRED`: the first user on an email domain must
  present a code to start a team; teammates after them join without one) and a
  public `POST /api/access-request` intake for the pre-release request-access
  flow; routes for Board + Backlog (two views of
  one nav entry, with a
  per-hierarchy-level switcher), Roadmap (grouped by release), Feature detail
  (spec content for leaf items; an editable rich-text Details body for DB-native
  items), and `/settings/*` (Profile, Repositories, Company, Hierarchy levels
  editor, Cards: card fields + custom properties + detail templates, …).
- **`apps/mcp`**: MCP server exposing status- and dependency-aware specs to agents.

## Key flows

1. **Connect repo**: an admin creates the deployment's GitHub App in one click
   (GitHub App *manifest* flow; credentials stored encrypted in `github_app`),
   installs it and picks repos, then connects one → scan `specs/**` per
   `.specboards/config.yml` → create `features` + `spec_index`, injecting missing `id`s.
   Each spec's work item is homed under a Feature grouping, found or created by a
   stable key (the spec's `feature:` frontmatter, else its folder), so the hierarchy
   fills in on import without overriding any parent set later in the app (ADR 0002).
   Multiple repos (across multiple GitHub orgs) coexist in one workspace, one
   `repositories` row each. An admin can **disconnect** a repo
   (`DELETE /api/v1/repositories/:id`): the connection and the repo's GitHub links
   are removed, but imported items detach (`repo_id` → NULL) rather than delete.
2. **Reconcile on push**: `push` webhook → re-parse changed specs → update `spec_index`;
   `blob_sha` detects drift/conflicts. The same webhook handles `pull_request`/`issues`
   events to refresh the cached state of any `feature_github_links` (open → merged/closed).
3. **Edit spec in UI**: save → `packages/git` writes a commit or opens a PR
   (`writeMode`) → webhook confirms → index updates.
4. **Edit metadata in UI**: writes straight to DB (no git churn), real-time to boards.
5. **Agent via MCP**: `list_items` / `read_item` / `update_item` /
   `get_relations` (over `/api/mcp`): agents act on assigned, status-aware
   specs, and respect dependency sequencing (a feature's `blocks` /
   `blockedBy`).

## Multi-tenancy

`workspace` is the tenant root; every tenant row carries `workspace_id` and Postgres
**RLS** isolates tenants (`specboards_is_member(workspace_id)` via the
`app.user_id` transaction-local session variable set by the app).
SaaS = many workspaces on shared infra; self-host = a single workspace.

Org and product are **URL path prefixes** (`/{org}/{product}/…`); the slug is a hint
whose authority is re-checked against membership server-side, and a product is a DB
grouping (`features.product_id`) that can span repos. See
[`docs/adr/0001-multi-tenancy-url-and-product-grouping.md`](docs/adr/0001-multi-tenancy-url-and-product-grouping.md).

## Open-core boundary

- **Open source (Apache-2.0):** spec editor, kanban/backlog/roadmap, GitHub git sync,
  MCP server, single-workspace self-host, docker-compose deploy.
- **Commercial (hosted SaaS):** multi-tenant hosting, SSO/SAML/SCIM, advanced
  analytics/insights, premium integrations (Jira/Linear/Slack), audit logs, support.

Commercial code stays in clearly separated, flag-gated modules so the OSS build is
fully functional standalone (no crippleware).

## Tech stack

Turborepo + pnpm workspaces · TypeScript · Next.js (App Router) · Drizzle ORM ·
Postgres (RLS multi-tenancy) · Better Auth · `@modelcontextprotocol/sdk` ·
`octokit` (GitHub App).

## Deployment

- **Self-host:** `infra/docker-compose.yml` (web + Postgres).
- **SaaS:** Fly.io Machines running `infra/web.Dockerfile` (the same image
  self-hosters run) + Fly Postgres (legacy `fly postgres`, PG 17); auth via
  Better Auth in-app.
  Two environments: test.specboards.ai (every push to `main`) and
  app.specboards.ai (manual promote). Migrations in `infra/migrations/`.

## Local file mode (development/testing)

When `DATABASE_URL` is unset, `apps/web` swaps its store implementation
(`apps/web/src/lib/store`) for a filesystem-backed one: specs are read directly
from this repo's `specs/` directory and metadata persists to
`.specboards/local-metadata.json`. Same UI, zero infrastructure, useful for UI
testing and for dogfooding Specboards on its own specs. Postgres mode is the
deployment shape.

## Status

**Active build.** Working: web UI (Backlog · Board · Roadmap · Feature detail,
base shadcn styling), spec parser + status workflow (`packages/core`), Drizzle
schema/migrations/seed (`packages/db`), DB-backed MCP tools (`apps/mcp`), local
file mode; full auth (Better Auth: email/password sign-up/in, email
verification, password reset, account/company settings, optional consumer-domain
blocking, session-gated writes); GitHub App sync (`packages/git`): one-click
in-app App setup (manifest flow), repo install + connect picker, push reconcile
into `features`/`spec_index`, stable-id injection. Interactive board:
drag-and-drop status change + manual reorder, click-to-edit drawer, per-user
customizable card fields. Card configuration in Settings → Cards: admin-defined
custom properties (Notion-style, per-level), releases (grouped on the Roadmap),
and reusable detail templates assignable per level. New cards capture a
rich-text Details body (stored as Markdown), editable on the item page. GitHub
feature linking: attach a PR/issue/branch to a feature, rolled up to parents,
with live state refresh via the webhook. Still
stubbed: editing spec content from the UI (PR write-back), spec **deletion**
handling. See `docs/archive/PLAN.md` for the original build plan, `docs/BACKLOG.md`
for where the backlog now lives (in Specboards), and `docs/RUNBOOK-github-sync.md` for setup.
