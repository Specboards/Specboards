# SpecBoard

A lightweight, spec-based product-management layer for **spec-driven development**.

Your specs stay canonical in git (versioned with code, read by AI coding agents).
SpecBoard layers the product metadata — status, assignment, priority, backlog
order, roadmap, dependencies, epic/sub-feature hierarchy — **on top** of them,
so PM, UX, and engineering collaborate without editing files in a terminal and
without duplicating work into JIRA/Aha.

Open-core: self-host the core for free, or use the hosted SaaS.

- **Design:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **Build plan:** [`docs/PLAN.md`](./docs/PLAN.md)

> Status: **active build**. Working: the web UI (Backlog · Board · Roadmap ·
> Feature detail with dependencies/relations), spec parsing, status workflow,
> DB schema/seed, MCP tools, auth (sign-up/in, email verification, password
> reset, account/settings), and GitHub sync (one-click App setup, repo
> connect/picker, push reconcile). Still stubbed: editing spec content from the UI.

## Layout

```
apps/
  web/        Next.js App Router UI (Backlog · Board · Roadmap · Feature detail)
  mcp/        MCP server exposing specs + metadata to coding agents
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

## Repo conventions for specs

Specs live under `specs/<feature>/spec.md` with YAML frontmatter:

```yaml
---
id: <uuid> # stable link to SpecBoard metadata (survives renames)
title: My Feature
kind: feature
---
```

Per-repo config (which globs are specs, workflow, custom fields, write mode)
lives in [`.specboard/config.yml`](./.specboard/config.yml).

## Local testing — quick start

Requires Node 22+ and pnpm 10+. No database needed:

```bash
pnpm install
pnpm build
pnpm --filter @specboard/web dev   # http://localhost:3000
```

Without `DATABASE_URL`, the app runs in **local file mode**: it reads
`specs/**/spec.md` straight from this repo and persists PM metadata (status,
priority, tags, quarter) to `.specboard/local-metadata.json`. The committed
file pre-populates the boards with this repo's own specs; edit freely and
`git checkout .specboard/local-metadata.json` to reset.

### With Postgres (the real deployment shape)

```bash
pnpm db:up        # docker compose Postgres on :5432 (or bring your own)
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/specboard
pnpm db:migrate   # apply infra/migrations
pnpm db:seed      # import specs/** into features + spec_index
pnpm --filter @specboard/web dev
```

The UI is identical; metadata now lives in `features` rows, matching the
architecture's system-of-record split.

### MCP server (agents)

```bash
pnpm --filter @specboard/mcp build
DATABASE_URL=postgres://... node apps/mcp/dist/server.js
```

Exposes `list_features` (with each feature's `blocks` / `blockedBy`) /
`read_spec` / `update_status` (workflow-validated) / `get_relations` over stdio.
Requires the seeded Postgres above.

## Develop

```bash
pnpm build          # turbo: builds all packages/apps
pnpm test           # runs unit tests (e.g. the spec parser in packages/core)
pnpm typecheck
```

### Database

```bash
pnpm --filter @specboard/db generate   # emit table migrations into infra/migrations
pnpm db:migrate                         # apply against $DATABASE_URL (incl. RLS policies)
```

### Self-host

```bash
docker compose -f infra/docker-compose.yml up   # web (infra/web.Dockerfile) + Postgres
```

## License

Apache-2.0 for the open-core. Commercial SaaS-only features (multi-tenant
hosting, SSO/SAML/SCIM, advanced analytics, premium integrations, audit logs)
are licensed separately.
