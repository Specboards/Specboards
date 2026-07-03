# Specboard

A lightweight, spec-based product-management layer for **spec-driven development**.

Your specs stay canonical in git (versioned with code, read by AI coding agents).
Specboard layers the product metadata **on top** of them: status, assignment,
backlog order, releases, custom properties, a rich-text details body,
dependencies, and epic/sub-feature hierarchy. PM, UX, and engineering
collaborate without editing files in a terminal and without duplicating work
into JIRA/Aha.

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

## Repo conventions for specs

Specs are **work items** (the spec-backed leaf of the hierarchy). They live under
`specs/<feature>/spec.md` with YAML frontmatter:

```yaml
---
id: <uuid> # stable link to Specboard metadata (survives renames)
title: My Feature
kind: feature
feature: checkout # optional: groups this spec under a named Feature (else its folder is used)
---
```

On import each spec is homed under a **Feature** grouping, by its `feature:` value
when set, otherwise by its folder (specs in the same directory share a Feature). The
hierarchy above the leaf (Feature → Epic → Initiative) is managed in the app, not git.

Per-repo config (which globs are specs, status workflow, write mode) lives in
[`.specboard/config.yml`](./.specboard/config.yml). Custom card properties are
admin-defined in the app (Settings → Cards), not in the repo config.

## Local testing: quick start

Requires Node 22+ and pnpm 10+. No database needed:

```bash
pnpm install
pnpm build
pnpm --filter @specboard/web dev   # http://localhost:3000
```

Without `DATABASE_URL`, the app runs in **local file mode**: it reads
`specs/**/spec.md` straight from this repo and persists PM metadata (status,
assignee, tags, release, details) to `.specboard/local-metadata.json` (plus
sibling `local-*.json` files for items, releases, properties, and templates).
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

Specboard is **open-core**. The core product, which includes the web app,
shared packages, MCP server, and single-org (`N=1`) self-hosting, is licensed
under the [Apache License 2.0](./LICENSE). You may run, modify, and self-host it
for any purpose, including commercially.

A small set of SaaS-oriented features are licensed separately: multi-tenant
hosting (`N>1`), SSO/SAML/SCIM, advanced analytics, premium integrations, and
audit logs. See [LICENSING.md](./LICENSING.md) for the full breakdown, or contact
**contact@palouse.io** for a commercial license.

The Specboard **brand** (name, logos, visual identity) and the marketing site
are **not** open source. They live in the separate
[Website](https://github.com/Specboards/Website) repo under a proprietary
license. Apache-2.0 does not grant trademark rights; see
[LICENSING.md](./LICENSING.md#brand-and-trademarks-all-rights-reserved).
