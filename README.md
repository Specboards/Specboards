# Specboards

**Product management that lives in your repo specs.**

Your specs stay canonical in the repo (versioned with your code, read by AI
coding agents). Specboards layers the product-management work *on top* of them:
status, priority, assignment, backlog order, roadmap, releases, dependencies,
and epic/feature hierarchy. PM, UX, and engineering plan together without
editing files in a terminal, and without copying every spec into Jira or Aha.

- **Open source.** Self-host the full app for free under the AGPL-3.0, modify it
  as you like, or use the hosted SaaS.
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
> **invite-only** ([request access](https://www.specboards.ai/request-access)).

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
  can customize the stages in `.specboards/config.yml`.
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
pnpm --filter @specboards/web dev   # http://localhost:3000
```

Without `DATABASE_URL`, the app runs in **local file mode**: it reads
`specs/**/spec.md` straight from this repo and persists product metadata
(status, assignee, tags, release, details) to `.specboards/local-metadata.json`.
The committed file pre-populates the boards with this repo's own specs; edit
freely and `git checkout .specboards/local-metadata.json` to reset.

### With Postgres (the real deployment shape)

```bash
pnpm db:up        # docker compose Postgres on :5432 (or bring your own)
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/specboard
pnpm db:migrate   # apply infra/migrations
pnpm db:seed      # import specs/** into features + spec_index
pnpm --filter @specboards/web dev
```

The UI is identical; metadata now lives in `features` rows, matching the
system-of-record split in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

### Self-host the full stack

```bash
cp infra/.env.example infra/.env   # then set a strong POSTGRES_PASSWORD
docker compose -f infra/docker-compose.yml up   # web + Postgres
```

Set the password before the first `up`: Postgres bakes it into the data volume
on initialization. The database port is bound to loopback only; keep it that
way (or drop the mapping) on any machine others can reach. Skipping the `.env`
step falls back to the sample `postgres` password, which is fine for a local
trial and unsafe anywhere else.

Optional environment flags for a hosted deployment:

- `APP_URL` - the deployment's canonical public origin (e.g.
  `https://specboards.example.com`), used to build OAuth callback, webhook, and
  discovery URLs. Strongly recommended whenever the app is reachable beyond
  localhost; multi-tenant deployments refuse to start without it (or
  `BETTER_AUTH_URL`), and it must be HTTPS outside local development.
- `SPECBOARDS_BLOCK_PUBLIC_EMAIL_DOMAINS` - reject sign-ups from consumer email
  providers (gmail.com, outlook.com, ...).
- `SPECBOARDS_SIGNUP_CODE_REQUIRED` - gate public sign-up behind a code (used for
  the pre-release beta): the first user on a given email domain must present a
  valid sign-up code to start a team; teammates who follow them on the same
  domain, and anyone holding a live org invitation, sign up without one.
- `SPECBOARDS_SIGNUP_CODE` - the code itself. Required whenever
  `SPECBOARDS_SIGNUP_CODE_REQUIRED` is on: there is no default, and the app
  refuses to start with the gate on and no code set. Choose a value only the
  people you are admitting know, and rotate it by changing this variable.
- `SPECBOARDS_INVITE_ONLY` - legacy gate: close public sign-up so only addresses
  with a pending org invitation can create an account. Superseded by
  `SPECBOARDS_SIGNUP_CODE_REQUIRED`; leave unset when the code gate is on.
- `ACCESS_REQUEST_NOTIFY_EMAIL` - where `POST /api/access-request` submissions
  are sent for review (default `contact@specboard.ai`). Submissions are also
  recorded in the `access_requests` table, which is the queue an operator works
  from; deciding one (and emailing the requester a sign-up code) is an operator
  action, done outside the app by a role granted UPDATE on that table.
- `ACCESS_REQUEST_ALLOWED_ORIGINS` - comma-separated CORS allow-list for that
  endpoint (default: the `specboards.ai` marketing origins + localhost).
- `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM` - transactional email (verification,
  password reset, invites, access-request notifications). Unset = email is a
  logged no-op.
- `SPECBOARDS_MODEL_ALLOW_PRIVATE` - let the model endpoint be a private or
  loopback address, which is what a self-hosted runtime on your own network is.
  Off by default and ignored (refused at boot) on a multi-tenant deployment.
- `SPECBOARDS_MODEL_CA_CERT` - PEM text, or a path to a PEM file, for an
  internal certificate authority or a self-signed certificate the model endpoint
  presents. Adds trust for the model endpoint only; public roots stay trusted.

### Bring your own model

Point Specboards at inference you own: an API key for a hosted provider, or the
base URL of a model you run yourself. Anything speaking the OpenAI-compatible
API works, which covers the hosted providers as well as vLLM, Ollama, llama.cpp
and most corporate gateways. Your workspace holds the vendor relationship and
pays for usage; keys are encrypted at rest and never returned to the browser.

Configure it in the app at Settings → Integrations → Model connection.

Because you pay for the inference, Settings → Integrations → **Usage** shows
what Specboards has spent at your endpoint this month, broken down by feature
and by person, and lets an owner set a monthly cap for the workspace and a daily
one per person. A request that would cross a cap is refused before it is sent.
Counted in tokens rather than money: the price of a token is between you and
your provider.

- Self-hosted, air-gapped, and private TLS, with worked examples:
  [`docs/GUIDE-self-hosted-model.md`](./docs/GUIDE-self-hosted-model.md).
- Credential storage, rotation, revocation, and the egress policy:
  [`docs/RUNBOOK-model-provider-credentials.md`](./docs/RUNBOOK-model-provider-credentials.md).

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
in [`.specboards/config.yml`](./.specboards/config.yml). Custom card properties
are admin-defined in the app (Settings → Cards), not in the repo config.

## MCP for AI agents

Specboards speaks the Model Context Protocol so coding agents (Claude Code and
others) can read and drive the backlog. Two ways to connect:

**Hosted endpoint (recommended).** Every deployment serves an authenticated MCP
endpoint at `POST /api/mcp` (e.g. `https://app.specboards.ai/api/mcp`). Two ways
to authenticate:

- **OAuth 2.1** for a person's own coding agent. Point your client at the URL,
  approve the browser consent screen (which asks which workspace to bind to and
  how much access to grant), and the connection binds to your user.
- **`Authorization: Bearer sb_…`** for anything running unattended, using an
  agent identity's key (Settings → Integrations → Agents). `x-api-key: sb_…`
  is accepted too, but prefer the bearer header: it is what MCP clients
  configure by default, and what the endpoint's own error text names.

For connecting a customer's agent, the guide at `/docs/agents` in the app covers
this properly: the two paths, what each grant allows, worked authoring flows,
the request and write quotas, and what the board records about an agent.

Tools, by what they manage:

- **Orientation:** `whoami`, `list_statuses`, `list_products`,
  `list_product_groups`, `group_summary`.
- **Work items:** `list_items`, `read_item`, `get_relations`, `create_item`,
  `update_item`, `delete_item`, plus `create_spec` and `update_spec_content`
  (both commit to git) and `list_github_links` / `link_github` /
  `unlink_github`.
- **Releases and cycles:** `list_releases` / `create_release` /
  `update_release` / `update_release_notes`, and `list_cycles` /
  `create_cycle` / `update_cycle` / `rollover_cycle`.
- **Goals:** `list_goals`, `read_goal`, `create_goal`, `update_goal`,
  `delete_goal`, `create_key_result`, `update_key_result`,
  `delete_key_result`, and `link_goal` to record that work ladders up.
- **Strategy, Research and Architecture:** `list_docs`, `read_doc`,
  `create_doc`, `update_doc`, `delete_doc`. One set of tools whichever way the
  area is backed: pages Specboards holds, or Markdown in a connected GitHub
  repo, where a page's id is its repo path and every edit is a commit. An area
  that only links out (SharePoint, Notion) is read-only, and `list_docs`
  returns the link.

**Local stdio server (self-host / offline).**

```bash
pnpm --filter @specboards/mcp build
DATABASE_URL=postgres://... node apps/mcp/dist/server.js
```

Exposes a read/update subset (list, read, relations, status) over stdio against
the seeded Postgres above.

## CLI

`specboards` manages work items (status, assignment, GitHub links) from the
terminal over the same `/api/v1` surface, authenticating with a personal API
key. Great for git hooks and CI.

```bash
pnpm --filter @specboards/cli build
node apps/cli/dist/index.js help

specboards auth login --url https://app.specboards.ai   # paste an sb_… key
specboards whoami
specboards features --mine --status in_progress
specboards status <specId> in_review --advance         # walk intermediate stages
specboards link <specId> --pr 42
```

Once published, the CLI installs without the monorepo via `npx @specboards/cli`,
`npm i -g @specboards/cli`, or `brew install specboards/tap/specboards`. The full
REST surface it drives is described by an OpenAPI document at
`/api/v1/openapi.json`, and API keys can be scoped (`<resource>:read` /
`<resource>:write`).

See [`apps/cli/README.md`](./apps/cli/README.md) for the full command list.

## Repo layout

```
apps/
  web/        Next.js App Router UI + the hosted MCP endpoint (/api/mcp, OAuth 2.1)
  mcp/        Standalone stdio MCP server (self-host / offline agent access)
  cli/        `specboards` CLI over the /api/v1 surface (API-key auth)
packages/
  core/       Spec parsing, status state machine, .specboards/config.yml schema
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
- **Archived plans:** [`docs/archive/`](./docs/archive/) (shipped work, kept for history)

## Develop

```bash
pnpm build          # turbo: builds all packages/apps
pnpm test           # unit tests (e.g. the spec parser in packages/core)
pnpm typecheck
```

### Database

```bash
pnpm --filter @specboards/db generate   # emit table migrations into infra/migrations
pnpm db:migrate                         # apply against $DATABASE_URL (incl. RLS policies)
```

Deployed environments apply migrations themselves: the container image carries a
bundled runner (`migrate.mjs`) plus the SQL, and Fly runs it as the
`release_command` before a new version takes traffic, aborting the release if it
fails. Self-hosting the image works the same way:

```bash
docker run --rm -e DATABASE_URL=postgres://… ghcr.io/…/specboards node migrate.mjs
```

## License

Specboards is **open source** under the
[GNU Affero General Public License v3.0](./LICENSE) (AGPLv3), and is also
available under a separate **commercial license**. The whole application, which
includes the web app, shared packages, MCP server, and self-hosting (including
the multi-tenant code path), ships in this repository. You may run, modify,
extend, and self-host it for any purpose, including for your own commercial use,
under the AGPL.

Because AGPLv3 is a network copyleft, if you run a modified Specboards as a
service for others you must offer them your source under the AGPL. If you want to
offer Specboards as a hosted service without that obligation, embed it in a
proprietary product, or work under an organization that bars AGPL software, take
the commercial license instead. It also bundles enterprise add-ons (SSO/SAML/SCIM,
advanced analytics, audit logs) and support. See [LICENSING.md](./LICENSING.md)
for the full breakdown, or contact **contact@specboard.ai**.

One exception: the CLI client (`apps/cli`, the published `@specboards/cli`) is
licensed under [Apache-2.0](./apps/cli/LICENSE), not AGPLv3, so you can embed and
script against it freely.

The Specboards **brand** (name, logos, visual identity) and the marketing site
are **not** open source. They live in the separate
[Website](https://github.com/Specboards/Website) repo under a proprietary
license. AGPLv3 is a copyright license and grants no trademark rights; see
[LICENSING.md](./LICENSING.md#brand-and-trademarks-all-rights-reserved).
