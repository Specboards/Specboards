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

Every item at every level is a `features` row. A spec is an **optional
attachment** to a leaf item (Work Item), not its identity: agent work items have
a spec, human work items may not, and both roll up the same way. An item "has a
spec" exactly when a `spec_index` row exists for it, which is what `isDbNative`
reports (it means "no attached spec", not "no repo"). Grouping levels
(Initiative / Epic / Feature) never carry specs. Every row takes a `spec_id`,
equal to the frontmatter id when a spec is attached and to its own row id
otherwise, so every item is uniformly routable. Item permalinks are
type-segmented by level: `/{org}/{product}/backlog/{levelKey}/{specId}` (the bare
`/backlog/{specId}` still redirects). See
[`docs/adr/0002-work-item-leaf-and-typed-item-urls.md`](docs/adr/0002-work-item-leaf-and-typed-item-urls.md)
and [`docs/adr/0003-spec-as-attachment.md`](docs/adr/0003-spec-as-attachment.md).

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
- **`packages/db`**: Drizzle schema + Postgres client. RLS policies live in
  `infra/migrations`, which are hand-written rather than generated, so the SQL
  is authoritative wherever Drizzle cannot express a constraint.

  The schema is described by area rather than enumerated here. An exhaustive
  table list in this file went stale within two releases and was misleading in
  the way that matters most, by reading as complete; `packages/db/src/schema.ts`
  is the list, and each table carries its own rationale.

  - **The work model.** `workspaces` and `members` are the tenant root.
    `workspace_levels` holds the per-workspace hierarchy (default Initiative →
    Epic → Feature → Work Item, only the leaf spec-backed) plus each level's
    available card fields and default detail template. Every item at every level
    is a `features` row: self-referential `parent_id` for the hierarchy, `level`
    composite-FK'd to `workspace_levels`, a nullable `repo_id` (`ON DELETE set
    null`, so disconnecting a repo detaches its imported items rather than
    deleting them), a fractional `rank` for manual ordering, a nullable
    `release_id`, a `custom_fields` jsonb map, and a `details` Markdown body for
    DB-native items. Around it: `feature_links` (typed dependencies),
    `feature_github_links` (PR/issue/branch with cached state), `spec_index`
    (content cache + git path/sha), `comments`, `item_events`, `activity_log`.
  - **Planning.** `releases` and `cycles` (ship vehicles and sprints, scheduled
    independently), `goals` / `key_results` / `goal_links` (what work ladders up
    to), `ideas` and their settings/statuses/votes (intake), `doc_spaces` /
    `doc_pages` (Strategy, Research, Architecture, backed by Specboards or by a
    connected repo).
  - **Configuration.** `workspace_properties`, `workspace_statuses`,
    `workspace_stage_gates`, `detail_templates`, `product_settings`,
    `products` / `product_groups` / `product_members` / `product_repositories`,
    `saved_views` and `board_preferences` (both per user).
  - **Integrations and inference.** `repositories` and the deployment-global
    `github_app` credential row, plus the GitHub install/token/webhook tables;
    `webhook_endpoints` and `webhook_deliveries` with `outbox_events` behind
    them; `mcp_workspace_bindings` and the OAuth tables for agent connections;
    `model_providers` and `model_provider_credentials` (split so a member can
    resolve the endpoint while the secret stays owner-only),
    `assistant_messages`, `workspace_assistant_skills`, and
    `model_usage_events` / `workspace_usage_limits` for spend accounting.
  - **Platform.** Better Auth's `users` / `sessions` / `accounts` /
    `verifications`, `api_keys`, `invitations`, `notifications`,
    `rate_limits` / `operation_limits`, `spec_write_audit`, and
    `access_requests` (pre-release intake; RLS on with no policies and no grant,
    so the tenant connection cannot read it).
- **`packages/git`**: GitHub App client + reconciler (`reconcileSpecs`), webhook
  verification/affected-spec resolution, installation-repo listing (via `octokit`).
- **`packages/ui`**: shared design tokens / components.
- **`apps/web`**: Next.js App Router UI; left sidebar nav with light/dark theme;
  in-app auth via Better Auth (`/api/auth/*`: sign-up/in, email verification,
  password reset), with an optional sign-up-code gate
  (`SPECBOARDS_SIGNUP_CODE_REQUIRED`: the first user on an email domain must
  present a code to start a team; teammates after them join without one) and a
  public `POST /api/access-request` intake for the pre-release request-access
  flow (submissions land in `access_requests`, which the internal admin portal
  reviews and approves directly); routes for Board + Backlog (two views of
  one nav entry, with a
  per-hierarchy-level switcher), Roadmap (grouped by release), Feature detail
  (spec content for leaf items; an editable rich-text Details body for DB-native
  items), and `/settings/*` (Profile, Company, Products, Hierarchy, Work cards,
  Ideas, Branding, Assistant, Repositories, Webhooks, API keys, and Integrations,
  which is where the MCP endpoint, agent identities and the model connection
  live).
- **`apps/mcp`**: standalone stdio MCP server for self-host and offline agent
  access, exposing a read/update subset over a direct database connection. Note
  that it is a **separate surface** from the hosted `/api/mcp` endpoint in
  `apps/web`, with its own smaller tool vocabulary (`list_features`, `read_spec`,
  `update_status`, `get_relations`) rather than the hosted endpoint's
  `list_items` / `read_item` / `update_item`. The two are not kept in step, and
  an agent written against one will not work unchanged against the other.
- **`apps/cli`**: the `specboards` CLI over `/api/v1` with API-key auth. Licensed
  Apache-2.0 rather than AGPL so it can be embedded and scripted against freely.

### Assistant and inference

The one interface the product uses to reach a model is `ModelClient`
(`apps/web/src/lib/ai/provider.ts`), with a single OpenAI-compatible adapter
behind it. Every call goes through `lib/model-provider-service.ts`, which
resolves the workspace's connection, decrypts its credential, applies the egress
policy, checks the spend cap, and writes the usage ledger. That is deliberately
the only entry point: it is where "whose money is this" is enforced as a
required argument, so no call site can spend a customer's budget anonymously.

The assistant itself has one hard constraint, enforced structurally rather than
by convention: **there is no code path from a model's output to a write.** An
answer may contain a proposed edit, which is inert text inside a stored message
until a person opens the item, reads the diff and accepts it. Accepting then
takes the ordinary item write path, with the same product-write permission, the
same repo write mode, the same conflict guard and the same history.

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

## License boundary

The whole application ships in this repository under the **GNU AGPLv3**
(open source): spec editor, kanban/backlog/roadmap, GitHub git sync, MCP server,
self-host, docker-compose deploy, and the multi-tenant code path. You may run,
modify, and self-host all of it, including for your own commercial use. AGPLv3's
network copyleft means a modified Specboards run as a service for others must
offer its source to those users. A separate **commercial license** lifts that
obligation and bundles enterprise support.

- **AGPLv3, self-host and modify freely:** `apps/web`, `apps/mcp`,
  `packages/**`, and `infra/**`.
- **Apache-2.0 exception:** the `apps/cli` client (`@specboards/cli`) is
  Apache-2.0 so it can be embedded freely; it is a self-contained REST client
  with no AGPL linkage.
- **Reasons to take the commercial license:** offering Specboards as a
  hosted/managed service to others without releasing your changes, embedding it
  in a proprietary product, an AGPL-barring org policy, or wanting enterprise
  features (SSO/SAML/SCIM, advanced analytics, audit logs) and support.

The single-vs-multi-tenant split is a runtime flag (`SPECBOARDS_MULTI_TENANT`),
not withheld code: self-host defaults to `N=1`, hosted opts in. See LICENSING.md.

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

**Active build, pre-release.** A feature-by-feature status list used to live
here and is deliberately gone: it was a second backlog that nobody updated, and
by the time anyone read it the two things it still called "stubbed" (editing
spec content from the UI, and spec deletion) had both shipped. A list that is
wrong about what works is worse than no list, because it is believed.

Where to look instead:

- **What is built and what is next:** the backlog itself, in Specboards. See
  [`docs/BACKLOG.md`](docs/BACKLOG.md) for the pointer.
- **What shipped when:** [`CHANGELOG.md`](CHANGELOG.md), which is kept per
  release.
- **How to set up GitHub sync:** [`docs/RUNBOOK-github-sync.md`](docs/RUNBOOK-github-sync.md).
- **How to self-host safely:** [`docs/SECURITY-self-host-checklist.md`](docs/SECURITY-self-host-checklist.md),
  and [`docs/GUIDE-self-hosted-model.md`](docs/GUIDE-self-hosted-model.md) for
  on-prem or air-gapped inference.

This document describes the **shape** of the system, which changes far more
slowly than its feature set. Anything here that reads as a progress report has
outlived its usefulness and should be deleted rather than updated.
