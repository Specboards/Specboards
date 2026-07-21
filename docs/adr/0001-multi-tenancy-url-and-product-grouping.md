# ADR 0001: Multi-tenancy, URL tenancy, and products as DB groupings

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Jonathan Butler
- **Supersedes:** the implicit "one workspace per deployment" model

## Context

Specboards began as **one organization per deployment**: the data layer is
fully tenant-scoped (every tenant table carries `workspace_id`, Postgres RLS
keys on the `app.user_id` session variable, and `members` is
`unique(workspace_id, user_id)`), but the *resolution* layer hardcodes a single
org:

- `getActiveWorkspace()` returns the first workspace ever created
  (`order by created_at limit 1`).
- `getMembership(db, userId)` returns one membership via `.limit(1)`.
- `ensureMembership()` auto-joins every authenticated user to that one
  workspace as `viewer`.

Three forces now push past that model:

1. **Multi-org users.** An external contractor with one email may need to
   belong to several organizations.
2. **Open-core / dual deployment.** Customers can self-host (on-prem), while we
   run hosted instances. We will **not** spin up new infrastructure per hosted
   customer, and we must **not** impede the self-host story.
3. **Readable, shareable URLs** that make the active org (and product) obvious.

The schema is already shared-multi-tenant capable; only resolution and routing
assume a single org.

## Decision

### D1. One codebase, always multi-tenant internally; single-tenant is N=1
The app is *always* multi-tenant in its internals: the active org is resolved
explicitly, validated against `members`, and applied as an explicit
`workspace_id` filter on every query. **Single-tenant is the N=1 special case**
behind a config flag, never a forked code path.

- **Hosted** = shared multi-tenant. A new customer is a **row, not infra**. One
  deployment, one Postgres; RLS + the explicit filter isolate tenants.
- **Self-host** = the same image against the customer's own Postgres, running
  single-tenant. It is its **own identity island**: cross-org-same-email
  federation is a **hosted-only** feature (analogous to two separate GitHub
  Enterprise servers). On-prem therefore needs no SSO/central-identity story to
  ship.
- **Default is single-tenant** (`SPECBOARD_MULTI_TENANT` unset/false) so the
  OSS / self-host path is the simple one; hosted opts in.

This is also the **open-core seam**: the OSS core is the single-tenant app; the
commercial/hosted layer is the multi-tenant management around it (provisioning,
billing, seat limits, SSO/SAML, org switcher, audit). Tenant resolution sits
behind an interface so the OSS build ships a trivial resolver and hosted injects
the commercial one.

### D2. Kill "first workspace"; resolve + validate the active org
`getActiveWorkspace() = first` is removed from request paths. The active org is
resolved from the URL (D3), validated against the caller's memberships, and used
both to set `app.user_id` for RLS **and** as an explicit `workspace_id` filter.
RLS is the backstop, not the selector. Because RLS authorizes by *membership*,
a multi-org user would otherwise pass RLS for every org they belong to at once.

### D3. Tenancy in the URL: path prefix `/{org}/…`
Org is a **path prefix**, not a subdomain (one cert, trivial on Fly, works in
local dev, shareable). The slug is a **routing hint** whose authority is always
re-checked server-side (`session.user ∈ members(orgSlug)`), else a deliberate
404. `workspaces.slug` already exists (`notNull`, `unique`). Self-host has one
fixed slug and redirects `/` → `/{theOrg}/…`; the org switcher is hidden.

Subdomain isolation (`{org}.specboard.ai`) is a deferred option for hard
isolation later.

### D4. Separate identity from context in URLs
> **Superseded by [ADR 0002](0002-work-item-leaf-and-typed-item-urls.md).** Item
> URLs now carry a level-key type segment, and only the leaf (Work Item) has a
> git spec id. Groupings are app-native, identified by their DB id.

- **Identity = the git spec id** (`features.specId` from frontmatter): global,
  stable, the canonical route param. This is what keeps everything grounded in
  the repo/spec.
- **Context = org and product**: navigation prefixes layered on top.

Item permalinks stay shallow and stable; context segments redirect when stale.
We will **never** product-scope or renumber item ids (no Jira-style `PROJ-123`).

### D5. Products are DB groupings (model "a"), not git repos
A product is a DB-side grouping (`features.product_id`, like `status` /
`priority` / `roadmap_quarter`: PM metadata in the DB while spec content stays
canonical in git). **A product may be supported by multiple git repos**, so a
product cannot be 1:1 with a repo (repos remain workspace-scoped for now).

Consequences:
- A feature moving products is a **DB flip + 301 redirect**, not a conflict. It
  is cheap precisely because the spec id is global. `/{org}/{oldProduct}/…/{id}`
  redirects to the feature's current product.
- The URL shape is forward-compatible if we ever revisit product↔repo grounding;
  only the id-uniqueness scope would tighten. We are not committing to that.

### D6. "Backlog" is the work area; Board and List are views
> **Item URL superseded by [ADR 0002](0002-work-item-leaf-and-typed-item-urls.md):**
> the item permalink is now `/{org}/{product}/backlog/{levelKey}/{specId}` (the
> bare `/backlog/{specId}` shape still redirects). The area/view decisions below
> stand.

Board (kanban) and the table are already "two views of the same features"
(`work-view-tabs.tsx`). Formalize it:

- **Area:** `/{org}/{product}/backlog`
- **Views:** `?view=board|list` (default `board`). A view is list-state, like
  the existing URL-resident filters; using a query param also avoids a path
  collision between view names and item ids.
- **Item:** `/{org}/{product}/backlog/{specId}`

(If "Backlog" later grates for non-leaf items, `Work`/`Items` is a fine area
rename; not blocking.)

## Resulting URL shape

```
/{org}/{product}/backlog?view=board|list      ← board / list views
/{org}/{product}/backlog/{specId}             ← item permalink (specId = identity)
/{org}/{product}/roadmap
/{org}/{product}/{strategy|research|ideas}     ← future areas, same scoping
/{org}/settings/…                              ← org-scoped, product-agnostic
```

Sidebar: an **Org switcher** at the top of the rail, a **Product switcher**
below it, then the areas (Strategy · Research · Ideas · Backlog · Roadmap), all
scoped by the active org + product.

## API patterning

- First-party browser calls keep the flat `/api/v1/…` surface with the org
  resolved from the session.
- External / multi-org-token consumers get **org in the path**:
  `/api/v1/orgs/{orgId}/products/{productKey}/features` so a token valid for
  several orgs is unambiguous. The path `orgId` is validated and feeds the same
  scope resolver (`app.user_id` + explicit `workspace_id` filter).
- API keys/tokens are **org-scoped** (a key belongs to one org), removing
  "which org?" ambiguity for machine clients.

## Consequences

**Positive:** contractor multi-org works on hosted; no per-customer infra; OSS
and hosted share one safe code path; readable shareable URLs; clean open-core
seam; links survive feature moves.

**Negative / risks:** the path-prefix migration touches every route, link,
redirect, and the API surface; the "always resolve + filter, never trust first
workspace" discipline must be applied everywhere (an IDOR risk if missed); the
org switcher and active-org session state add machinery; deep links lose simple
per-org URLs unless we add `?product=` overrides later.

## Phased plan

1. **Foundation (no URL/UX change).** Tenancy config flag (default
   single-tenant); multi-membership reads; a centralized, validated
   active-workspace resolver that replaces `getActiveWorkspace()=first`;
   `ensureMembership` able to target a specific workspace. Single-org behavior
   is byte-for-byte preserved.
2. **URL path prefix.** Move routes under `/{org}/…` (route group + middleware
   that resolves/validates the slug and redirects `/` → active org); org
   switcher; thread active org through `requireWorkspaceAccess`.
3. **Product in URL + backlog/board/list.** `/{org}/{product}/…`; sidebar org +
   product switchers; rename the work area to `backlog` with `?view=board|list`
   and `/backlog/{specId}` items; redirect-on-move for product context.
4. **Hosted multi-tenant management (commercial).** Org provisioning, billing,
   seat limits, SSO/SAML, audit. This is the open-core boundary.

## Open questions

- Org-scoped API tokens: issuance/rotation/scope model (Phase 4).
- Whether settings are ever product-scoped (today: org-scoped only).
- Subdomain isolation as a later hard-isolation tier for enterprise.
