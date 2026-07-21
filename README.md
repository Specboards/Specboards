# Specboards

**Product management that lives in your repo specs.**

Your specs stay canonical in the repo (versioned with your code, read by AI
coding agents). Specboards layers the product-management work *on top* of them:
status, priority, assignment, backlog order, roadmap, releases, dependencies,
and epic/feature hierarchy. PM, UX, and engineering plan together without
editing files in a terminal, and without copying every spec into Jira or Aha.

- **Open-core.** Self-host the Apache-2.0 core for free, or use the hosted SaaS.
- **Git-native.** No second source of truth. The specs in your repo *are* the
  backlog.
- **Agent-ready.** An MCP server gives coding agents the same prioritized plan
  your team works from.

Specboards is a member of the [Studio Palouse](https://www.studiopalouse.com)
family of apps.

> **Status: active build (pre-release).** Working today: the web UI (Backlog ·
> Board · Roadmap · Ideas · Feature detail), multi-product backlogs, releases,
> custom card properties, spec parsing, the status workflow, auth, one-click
> GitHub sync, and the MCP server for agents. The hosted service is currently
> **invite-only** ([request access](https://www.specboard.ai/request-access)).

## Why Specboards

You already write specs. What you're missing is the layer on top of them.

- **Not Jira / Aha** - no separate system of record to copy specs into and keep
  in sync. The repo stays canonical.
- **Not just an issue tracker** - your actual specification lives *with the
  code* and is readable by your AI agents, not stranded in a ticket description.
- **Not a wiki** - specs move through a validated status workflow and ship
  inside pull requests, instead of drifting away from the code.
- **Not plain markdown alone** - you get a backlog, board, roadmap, releases,
  and ownership around the spec files you already have.

## Features

- **Git-native specs.** Your `specs/**/spec.md` files stay the source of truth.
  Specboards parses each spec, injects a stable UUID when one is missing, and
  keeps a live, sha-tracked index. Renames and moves never orphan your data,
  because every spec is keyed by its id, not its path.
- **Ideas & intake.** Capture raw ideas and requests, then promote the ones
  worth doing straight into the backlog as specs.
- **Backlog & prioritization.** Rank, assign, tag, and prioritize in a fast
  backlog. Drag to reorder, save custom views, filter by product/status/owner.
- **Kanban board.** A status board with a validated workflow (backlog →
  defining → ready → in progress → in review → done, plus archived). Each repo
  can customize the stages in `.specboard/config.yml`.
- **Roadmap & releases.** Group work into initiatives and epics, lay it out by
  release and quarter, and track what ships when.
- **One-click GitHub sync.** Connect a repo with a GitHub App (no secrets to
  paste). Specboards imports specs, reconciles on every push, and links live PR,
  issue, and branch state to your work.
- **MCP for AI agents.** An MCP server exposes your prioritized, status-aware
  backlog to coding agents. They can list products and items, read specs, follow
  dependencies, update status and metadata, and write specs back to git.

## Quick start

Requires **Node 22+** and **pnpm 10+**. No database needed to try it locally:

```bash
pnpm install
pnpm build
pnpm --filter @specboard/web dev   # http://localhost:3000
```

Without `DATABASE_URL`, the app runs in **local file mode**: it reads
`specs/**/spec.md` straight from this repo and persists product metadata
(status, assignee, tags, release, details) to `.specboard/local-metadata.json`.
The committed file pre-populates the boards with this repo's own specs; edit
freely and `git checkout .specboard/local-metadata.json` to reset.

### With Postgres (the real deployment shape)

```bash
pnpm db:up        # docker compose Postgres on :5432 (or bring your own)
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/specboard
pnpm db:migrate   # apply infra/migrations
pnpm db:seed      # import specs/** into features + spec_index
pnpm --filter @specboard/web dev
```

The UI is identical; metadata now lives in `features` rows, matching the
system-of-record split in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

### Self-host the full stack

```bash
docker compose -f infra/docker-compose.yml up   # web + Postgres
```

Optional environment flags for a hosted deployment:

- `SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS` - reject sign-ups from consumer email
  providers (gmail.com, outlook.com, ...).
- `SPECBOARD_INVITE_ONLY` - close public sign-up; only addresses with a pending
  org invitation can create an account (used for the pre-release beta).
- `ACCESS_REQUEST_NOTIFY_EMAIL` - where `POST /api/access-request` submissions
  are sent for review (default `contact@specboard.net`).
- `ACCESS_REQUEST_ALLOWED_ORIGINS` - comma-separated CORS allow-list for that
  endpoint (default: the `specboard.ai` marketing origins + localhost).
- `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM` - transactional email (verification,
  password reset, invites, access-request notifications). Unset = email is a
  logged no-op.

## Working with specs

Specs are **work items**: the spec-backed leaf of the hierarchy. They live under
`specs/<feature>/spec.md` with YAML frontmatter:

```yaml
---
id: <uuid> # stable link to Specboards metadata (survives renames)
title: My Feature
kind: feature
feature: checkout # optional: groups this spec under a named Feature (else its folder is used)
---
```

On import each spec is homed under a **Feature** grouping, by its `feature:`
value when set, otherwise by its folder. The hierarchy above the leaf (Feature →
Epic → Initiative) is managed in the app, not git.

Per-repo config (which globs are specs, the status workflow, write mode) lives
in [`.specboard/config.yml`](./.specboard/config.yml). Custom card properties
are admin-defined in the app (Settings → Cards), not in the repo config.

## MCP for AI agents

Specboards speaks the Model Context Protocol so coding agents (Claude Code and
others) can read and drive the backlog. Two ways to connect:

**Hosted endpoint (recommended).** Every deployment serves an authenticated MCP
endpoint at `POST /api/mcp` (e.g. `https://app.specboard.ai/api/mcp`) with OAuth
2.1 sign-in, or an `x-api-key` for service accounts. Point your client at it,
approve the browser consent screen, and the connection binds to your user and
the workspace you pick.

Tools: `whoami`, `list_products`, `list_items`, `read_item`, `get_relations`,
`create_item`, `update_item`, `delete_item`, `update_spec_content` and
`create_spec` (both commit to git), and `list_releases` / `create_release` /
`update_release`.

**Local stdio server (self-host / offline).**

```bash
pnpm --filter @specboard/mcp build
DATABASE_URL=postgres://... node apps/mcp/dist/server.js
```

Exposes a read/update subset (list, read, relations, status) over stdio against
the seeded Postgres above.

## CLI

`specboard` manages work items (status, assignment, GitHub links) from the
terminal over the same `/api/v1` surface, authenticating with a personal API
key. Great for git hooks and CI.

```bash
pnpm --filter @specboard/cli build
node apps/cli/dist/index.js help

specboard auth login --url https://app.specboard.ai   # paste an sb_… key
specboard whoami
specboard features --mine --status in_progress
specboard status <specId> in_review --advance         # walk intermediate stages
specboard link <specId> --pr 42
```

Once published, the CLI installs without the monorepo via `npx @specboard/cli`,
`npm i -g @specboard/cli`, or `brew install specboard/tap/specboard`. The full
REST surface it drives is described by an OpenAPI document at
`/api/v1/openapi.json`, and API keys can be scoped (`<resource>:read` /
`<resource>:write`).

See [`apps/cli/README.md`](./apps/cli/README.md) for the full command list.

## Repo layout

```
apps/
  web/        Next.js App Router UI + the hosted MCP endpoint (/api/mcp, OAuth 2.1)
  mcp/        Standalone stdio MCP server (self-host / offline agent access)
  cli/        `specboard` CLI over the /api/v1 surface (API-key auth)
packages/
  core/       Spec parsing, status state machine, .specboard/config.yml schema
  db/         Drizzle schema + Postgres client (metadata + spec index)
  git/        GitHub App client, spec reader/writer, webhook reconciler
  ui/         Shared design tokens / components
infra/
  docker-compose.yml   Self-host stack (web + Postgres)
  migrations/          Drizzle migrations (tables, auth, RLS policies)
  web.Dockerfile       Web app image (self-host + Fly.io SaaS)
```

- **Design:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Backlog:** [`docs/BACKLOG.md`](./docs/BACKLOG.md) (tracked in Specboards)
- **Original build plan:** [`docs/archive/PLAN.md`](./docs/archive/PLAN.md)

## Develop

```bash
pnpm build          # turbo: builds all packages/apps
pnpm test           # unit tests (e.g. the spec parser in packages/core)
pnpm typecheck
```

### Database

```bash
pnpm --filter @specboard/db generate   # emit table migrations into infra/migrations
pnpm db:migrate                         # apply against $DATABASE_URL (incl. RLS policies)
```

## License

Specboards is **open-core**. The core product, which includes the web app,
shared packages, MCP server, and single-org (`N=1`) self-hosting, is licensed
under the [Apache License 2.0](./LICENSE). You may run, modify, and self-host it
for any purpose, including commercially.

A small set of SaaS-oriented features are licensed separately: multi-tenant
hosting (`N>1`), SSO/SAML/SCIM, advanced analytics, premium integrations, and
audit logs. See [LICENSING.md](./LICENSING.md) for the full breakdown, or contact
**contact@specboard.net** for a commercial license.

The Specboards **brand** (name, logos, visual identity) and the marketing site
are **not** open source. They live in the separate
[Website](https://github.com/Specboards/Website) repo under a proprietary
license. Apache-2.0 does not grant trademark rights; see
[LICENSING.md](./LICENSING.md#brand-and-trademarks-all-rights-reserved).
