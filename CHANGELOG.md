# Changelog

All notable changes to Specboard are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). See [VERSIONING.md](./VERSIONING.md)
for how and when the version is bumped.

## [0.18.2] - 2026-07-13

### Changed

- **New brand mark ("Slotted S") across all app icons.** Regenerated the
  favicon, app icon, Apple touch icon, OpenGraph image, and the in-app sidebar /
  auth / OAuth-consent mark (`public/brand/specboard-mark.png`) from the Gesso
  design system: a green rounded tile with a white "S" built from three board
  lanes and two offset connectors (the faded middle lane nods to "in progress").

## [0.18.1] - 2026-07-13

### Changed

- **Roadmap releases now lay out as horizontal, laterally-scrolling columns**
  instead of a wrapping grid that stacked them down the page. Matches the status
  Board's kanban idiom (fixed-width columns, `overflow-x` scroll), so adding a
  release pushes the row sideways rather than reflowing onto new rows.

## [0.18.0] - 2026-07-13

Expose releases through the MCP server so agents can organize the backlog into
versions, and consolidate the repo's implementation docs into Specboard itself.

### Added

- **`list_releases` and `create_release` MCP tools.** Agents can now read a
  workspace's releases (id, name, status, start/target dates, notes, item count)
  and create new ones, then schedule work into a release via
  `update_item(releaseId)`. `create_release` is owner-only, mirroring the
  admin-gated `POST /api/v1/releases` route; both are thin adapters over the same
  service layer the REST API uses, so authorization and validation are identical.

### Changed

- **README refreshed for how the app works today.** Documents the hosted
  `/api/mcp` OAuth 2.1 endpoint as the primary way agents connect (with the
  current tool set) alongside the local stdio server, and clarifies that agents
  edit spec content over MCP (committing to git) while the in-app spec editor is
  still stubbed.
- **Implementation docs consolidated into Specboard.** The product and platform
  backlog now lives in the Specboard workspace; shipped and migrated planning
  docs moved to `docs/archive/`, and `docs/BACKLOG.md` is now a pointer.

## [0.17.0] - 2026-07-12

Make browser sign-in the reliable way to connect an MCP client. The OAuth
consent screen now scopes a connection to the right identity and workspace, so
users no longer need a manual `x-org-slug` header or API key just to connect.

### Added

- **Workspace picker on the MCP consent screen.** A user who belongs to more
  than one workspace picks which one a connection targets when they approve it.
  The choice is stored per connection (keyed by user and OAuth client) and the
  hosted MCP endpoint reads it when no explicit `x-org-slug` header is present.
  An explicit header still wins, so one client can be pointed at two workspaces
  from two configs. Membership is re-validated on every request, so a binding to
  a workspace the user has left fails closed rather than granting access.

### Changed

- **The MCP consent screen confirms who you are.** It now shows "Signed in as
  {email}" with a "Not you? Switch account" link, so the account a connection
  binds to is a deliberate confirmation rather than easy-to-miss fine print.
- **A workspace-less account can no longer complete MCP consent.** If the
  signed-in account belongs to no workspace, the screen prompts you to switch
  accounts instead of minting a token that fails every later call with "you do
  not belong to a workspace."

## [0.16.0] - 2026-07-12

Administrative polish surfaced while dogfooding Specboard on Specboard, plus a
new MCP tool.

### Added

- **`delete_item` MCP tool.** Coding agents can now delete a DB-native card
  (initiative/epic/feature) through the hosted MCP, not just create and update.
  It wraps the same service path as the REST delete, so authorization, child
  re-parenting, relation cleanup, and webhook emission are identical.
  Spec-backed items are rejected (they are deleted in git).

### Changed

- **Creating a product now makes you its admin.** The person who creates a
  product is recorded as an explicit product admin, so they appear in the
  product's member list and keep that standing even if later demoted from org
  admin.
- **Repository management moved under Settings - Integrations.** Connected
  repositories are now a fourth tab (alongside MCP, API keys, and Webhooks)
  rather than a separate settings page, since a repository connection is a type
  of integration. The old `/settings/repositories` route redirects, preserving
  the GitHub install/callback banners.

## [0.15.0] - 2026-07-11

Security hardening batch from the July 2026 adversarial source review (see
`docs/archive/security-fixes.md`). No new product features; these close the P0-P2
findings.

### Changed

- **API requests now scope to an explicit, validated organization.** Requests
  carry the active org as an `x-org-slug` header (the browser derives it from
  the `/{org}/` route; the CLI reads `SPECBOARD_ORG` / `--org`), validated
  against a real membership. The old "resolve the caller's oldest membership"
  fallback is gone: a user in more than one org can no longer have a request
  silently resolve to the wrong tenant, and an ambiguous call is rejected.
  Single-org and self-host callers are unaffected.
- **Content-Security-Policy is now nonce-based.** `script-src` uses a
  per-request nonce with `strict-dynamic` and no longer allows
  `'unsafe-inline'`, so injected inline scripts are refused.
- **Auth rate limits are database-backed** (was in-process memory), so they
  hold consistently across instances.

### Fixed

- **GitHub App installation binding requires proof of account ownership.** The
  install flow now runs an OAuth identity step and binds an installation only
  when the signed-in user owns the personal account or is an active admin of
  the organization it belongs to, closing a takeover where a workspace owner
  could bind another tenant's installation. Requires `GITHUB_APP_CLIENT_ID` /
  `GITHUB_APP_CLIENT_SECRET` (hosted) or the in-app manifest flow (self-host).
- **Database tenant isolation fails closed.** The hosted app refuses to serve
  tenant data over an RLS-bypassing connection and verifies at boot that its
  tenant-data role is non-owner, non-superuser, without `BYPASSRLS`.
- **Webhook SSRF guard hardened** against DNS rebinding (the connection is
  pinned to the pre-validated address) and against IPv4-mapped/hex IPv6 forms
  (now judged with a maintained range parser).
- **Request bounds and quotas.** Body-size limits on the MCP and GitHub webhook
  routes, a JSON-RPC batch cap, and per-workspace quotas on expensive
  operations (repo scan/import/starter-spec/connect, webhook test sends).
- Structured `[security:*]` telemetry for rate-limit rejections, oversized
  requests, and invalid GitHub webhook signatures.

Migrations 0035 (GitHub install ownership) and 0036 (rate-limit tables),
applied to test and production.

## [0.14.0] - 2026-07-08

### Changed

- **Consolidated roles into a clear two-layer model** (migration 0034). The
  workspace has one admin role, **Owner** (rename the org, manage products and
  their relationships, manage members, and admin of every product); everyone
  else is a **Member** (read-only at the org, so they still see the
  cross-product rollups). Real capability is granted **per product**: **Admin**
  (manage that product's config + members, and edit it), **Contributor** (edit
  that product's items), or **Viewer** (read it). This replaces the old org
  roles (admin/pm/ux/eng/viewer) and product roles (admin/editor/viewer):
  `admin`→`owner`, pm/ux/eng→`member`, product `editor`→`contributor`. Existing
  per-product grants are preserved, so no one loses edit access. Write
  permission is now enforced per product end to end (web, REST, and MCP);
  `whoami` reports the caller's per-product access.

### Added

- **Invitations grant product access.** A single invite chooses Owner or Member,
  and a Member invite can grant access to several products at once (Admin /
  Contributor / Viewer per product), all applied atomically when the invite is
  accepted.

## [0.13.0] - 2026-07-08

### Added

- **Organization user management** (Settings → Company & Team; migration 0033
  adds the `invitations` table and a `members.deactivated_at` column). Admins
  now get a real team roster: change a member's org role, remove a member, or
  deactivate/reactivate them, all protected by a last-admin guard so the only
  admin can't be demoted, removed, or suspended.
- **Email invitations.** An admin invites a teammate by email with a chosen
  role; the invitee gets a signed `/invite/<token>` link (7-day expiry, hashed
  token stored, strict email match on accept), signs up or in, and joins the org
  automatically at the invited role. This is what makes a hosted, multi-tenant
  org usable by more than its founder. Pending invitations can be re-sent or
  revoked.
- **Member deactivation.** A suspended membership is denied everywhere at once
  (web pages, REST API, API keys, and MCP) via a single membership choke-point,
  without deleting the user. Deactivation is per-organization, so the same
  account can stay active in another org.

## [0.12.0] - 2026-07-07

### Added

- **Hosted MCP endpoint for AI agents** (`/api/mcp`). Coding agents (Claude
  Code, Claude Desktop, claude.ai) connect to a single Streamable-HTTP endpoint
  that exposes the backlog and git-backed specs through nine tools: read the
  hierarchy and items, edit metadata and DB-native card bodies, commit spec
  Markdown to the connected repo, and break a card down into child specs. Tools
  call the same service layer as the REST API, so auth, the status workflow,
  stage gates, and webhooks all match the web app. One endpoint serves both
  self-host and the hosted SaaS.
- **OAuth 2.1 sign-in for MCP** (migration 0032 adds `oauth_applications`,
  `oauth_access_tokens`, and `oauth_consents`). Adding the endpoint URL is
  enough: the client discovers the authorization server, registers itself
  (Dynamic Client Registration), and walks the user through sign-in and a
  consent screen in the browser; the agent then acts as that user and inherits
  their workspace role. PKCE is required for every client, every authorization
  is confirmed on an explicit consent screen, and loopback redirects follow
  RFC 8252 (any ephemeral port on `localhost`). A personal API key
  (`Authorization: Bearer sb_...`) remains the non-interactive alternative for
  CI.
- **Integrations settings** (Settings → Integrations), a tabbed view for MCP,
  API keys, and Webhooks, with an MCP connect panel that shows this
  deployment's endpoint URL and copy-paste setup for Claude Code and Claude
  Desktop.

## [0.11.0] - 2026-07-05

### Added

- **Plan / Build / Ship navigation with Strategy, Research, and Architecture
  areas** (migration 0030 adds `doc_spaces` and `doc_pages`). The sidebar groups
  work into Plan / Build / Ship sections and adds document areas that can hold
  Specboard-native rich-text pages or link out to an external source, with a
  source chooser per area.
- **GitHub-backed doc repositories** for the Research and Architecture areas. An
  admin can create a private org repo from the source chooser; the area then
  renders that repo's Markdown tree, and an explicit Save commits edits straight
  to the default branch. The docs repo is kept separate from spec sync.
- **Webhooks delivery log + manual redeliver** (Settings → Webhooks). Each
  endpoint expands to its recent deliveries (event, status, attempts, HTTP
  result, last error, time). A per-row **Redeliver** re-queues the stored
  envelope for an immediate resend, re-sending the original delivery id and
  signature so consumers can dedupe.

### Changed

- **Webhooks: auto-disable an endpoint after repeated failures** (migration 0031
  adds `webhook_endpoints.consecutive_failures`). A run of deliveries that give
  up (retry budget exhausted, or a blocked URL) disables the endpoint after the
  fifth consecutive failure, shown as **Auto-disabled** in the UI; any success or
  a manual Resume clears the streak. Stops a dead endpoint from generating doomed
  retry traffic.
- **Roadmap polish.** Selecting a card opens the same in-context preview panel as
  the Backlog board (instead of a full-page navigation); the release detail panel
  shows a proper title clear of the close button; columns without dates keep their
  cards aligned with dated columns; and the release **Release** action is now a
  primary button so it stands out from **Edit**.

## [0.10.1] - 2026-07-05

### Changed

- **Webhooks: durable transactional outbox** (migration 0029 adds
  `outbox_events`). Domain changes now record their event in the *same database
  transaction* as the change, closing the small window where a crash between the
  commit and the webhook enqueue could drop an event. A relay fans events out to
  the per-endpoint delivery queue and the drainer sends them as before, so
  delivery behavior is unchanged. The `outbox_events` stream is generic, so
  future consumers (notifications, an activity feed) can build on it. Processed
  events are pruned on a retention window (`SPECBOARD_OUTBOX_RETENTION_DAYS`,
  default 7) so the table doesn't grow without bound. No user-facing change.

## [0.10.0] - 2026-07-05

### Added

- **Outbound webhooks** (Settings → Webhooks, admin-only; migration 0028 adds
  `webhook_endpoints` and `webhook_deliveries`). Register HTTPS endpoints that
  receive a signed POST when items and releases change. Four events:
  `item.status_changed`, `item.created`, `item.deleted`, and `release.shipped`.
  Endpoints route per product (or workspace-wide) and subscribe to a chosen set
  of events. Delivery is durable: each event is written to a transactional
  outbox and an in-process drainer POSTs it with retries and exponential backoff
  (1m, 5m, 30m, 2h, 6h). Every request is signed Stripe-style
  (HMAC-SHA256 over the timestamp and body, sent as `X-Specboard-Signature`); the
  per-endpoint signing secret is generated server-side, encrypted at rest, and
  shown to the admin once. A "send test event" button delivers a sample payload
  and reports the result. Outbound URLs are SSRF-guarded (https only; private,
  loopback, link-local, and cloud-metadata targets are blocked), with an env
  opt-out for self-hosted installs. Webhooks require a database (off in local
  file mode).

## [0.9.0] - 2026-07-05

### Added

- **Roadmap: drag to schedule.** The Roadmap is now an interactive board.
  Editors drag a card into another release column to set its release (or into
  Unscheduled to clear it); the drop is optimistic, persists the release, then
  revalidates. Read-only viewers and the shipped view stay static.
- **Release detail panel with notes.** Clicking a release name opens a drawer
  showing its status, dates, item count, and Markdown notes (migration 0027
  adds a nullable `notes` column to `releases`). The Release / Reopen, Edit, and
  Delete actions now live in this panel instead of crowding the column heading,
  and editing happens inline there.
- **Ideas detail drawer.** Clicking an idea opens a full detail view (Markdown
  details, vote, and, for editors, edit / promote / delete) mirroring the
  feature flyout. Promote and Delete moved off the list row and into the drawer.

### Changed

- **Ideas: status is a distinct field.** The review-stage control on each idea
  row is now a low-chrome status pill (colored dot, label, chevron) rather than
  a button that looked like Promote. The list gains a status filter and a
  votes / newest / oldest sort.
- **Roadmap column heading.** The release name sits on its own line with the
  dates (and any non-default status) smaller beneath it, instead of a single
  crowded line of look-alike controls.

## [0.8.0] - 2026-07-04

### Added

- **Ideas (internal view)** (new "Ideas" area in the sidebar, per product;
  migration 0026 adds `ideas`, `idea_votes`, `idea_statuses`, and
  `idea_settings`). Teams can capture feature requests / feedback, vote on them
  (a demand signal that sorts the list), move each through a configurable review
  workflow (New → Under review → Planned → Shipped → Parked → Declined by
  default), and **promote** a worthwhile idea into a feature: promotion creates a
  DB-native item at the planning level, links it back to the idea, and advances
  the idea's status. Ideas are product-scoped with the same visibility rules as
  features; voting is open to any member, while editing/promoting/deleting follow
  the product write roles.
- **Settings → Ideas.** Admins configure the idea **review stages** (rename in
  place, reorder, add, remove; removing a stage re-homes its ideas to the first)
  and the **public portal** settings (publish toggle + portal heading). The
  public, unauthenticated voting portal built on this data is a planned
  follow-up; its configuration ships now.

## [0.7.0] - 2026-07-04

### Added

- **Workflow stage gates** (Settings → Cards → Workflow → Stage gates; migration
  0025 adds `workspace_stage_gates` and `feature_gate_completions`). Admins can
  attach a checklist to any stage. An item sitting in that stage shows the
  checklist on its detail view, and members tick items off as they go. A stage's
  checklist must be fully complete before the item can advance forward: the move
  is hard-blocked on the board and through the API until every gate is checked.
  Pulling an item back to an earlier stage or archiving it is always allowed. A
  multi-stage jump enforces the checklists of every stage it passes over, so
  gates can't be skipped by jumping. The MCP server's `update_status` enforces
  the same rule, so coding agents can't advance an item past its checklist.
  Renaming a stage keeps its gates; removing a stage clears them.

## [0.6.0] - 2026-07-04

### Added

- **Custom workflow stages** (Settings → Cards → Workflow; migration 0024 adds
  `workspace_statuses`). Admins can rename a stage in place (its key, and so its
  items, stay put), reorder, add, or remove stages; the board columns, status
  pickers, and transition validation all follow. Removing a stage re-homes its
  items to the first stage. The MCP server's status validation reads the same
  workflow. (Stage gates are a planned follow-up.)
- **URL field type** for custom properties, so items can link out to Figma,
  Miro, docs, etc. Rendered as a clickable link on the item, with an open-link
  affordance while editing.
- **Notion-style item detail.** Initiatives, epics, features, and work items now
  share one detail layout: the level, an inline-editable title, then a block of
  property rows (each with a type icon) for Status, Assignee, Release, Tags, and
  every custom property, followed by the rich-text body and the Relationships /
  Integrations sections.
- **Generate child items.** Each item has a "Generate {child level}" action that
  creates items one level down (Initiative → Epic, Epic → Feature, Feature →
  Work item) with the parent pre-selected; the drawer stays open to add several
  in a row. Manual today; an AI-assisted generator can slot in behind it later.
- The board **flyout is now resizable** (drag its left edge; the width is
  remembered) and renders the exact same layout as the full item page, backed by
  a new `GET /api/v1/features/:specId/context` endpoint.
- **Release lifecycle** on the Roadmap (migration 0023 adds `releases.start_date`):
  releases now carry a **start date** and a **ship date**, both editable after
  creation. A **Release** action marks a release shipped, which drops it and its
  items from the active roadmap (the assignment is kept for history) and moves it
  under a new **Shipped releases** view; shipped releases can be reopened from
  there.

### Changed

- **Board cards no longer carry a status dropdown** — the column already shows
  the stage, and dragging between columns is how the stage changes.
- **Card fields update live.** Toggling a field in the board's "Card fields" menu
  now updates the cards instantly (shared client state) instead of needing a
  page refresh.
- **Cards settings are grouped** into bordered panels — Workflow, Fields
  (built-in fields + custom properties), and Templates — so related controls
  read together.
- The item detail is retitled: the body sits under a **Description** heading with
  a roomier (~10-row) editor, and the **Relationships** and **Integrations**
  sections start collapsed until you expand them.
- The product attribution badge is now hidden when the workspace has only one
  product (it carried no information there), on both the board and the roadmap,
  in addition to the single-product view.
- Item bodies (and titles, for DB-native items) **auto-save** as you type; the
  manual "Save details" button is gone. Undo/redo use the editor's native
  history. Spec-backed bodies stay read-only (their source of truth is git).
- The flyout's "Open full spec" link is now an **Open fullscreen** expand
  control.
- On the Roadmap, the **Unscheduled column is hidden** when every item is
  assigned to a release.

### Fixed

- Newly entered item details no longer disappear after saving until a page
  reload. The editor previously remounted and reseeded from a stale value while
  `router.refresh()` was in flight; it now holds its content.

## [0.5.0] - 2026-07-03

### Added

- Card details are now first-class. Creating an initiative/epic/feature captures
  a **Details** body in a rich-text editor that stores Markdown behind the
  scenes, with a "Raw" toggle to edit the Markdown source directly. Details are
  shown and editable on the item page after creation (migration 0022 adds
  `features.details`).
- New-card creation also captures **Status** (defaults to the first stage in the
  workflow) and **Assigned To**, alongside the title.
- **Details Templates** (Settings → Cards): admins define reusable Markdown
  skeletons and assign a default template per hierarchy level, so new cards at
  that level start pre-filled. Ships with example templates to copy from.
- **Release editing** on the Roadmap: rename a release and change its status or
  target date inline, in addition to the existing create/delete.

### Changed

- The Roadmap and Backlog "New {level}" drawer now includes status, assignee,
  and the Details editor.

## [0.4.0] - 2026-07-03

### Added

- Custom properties, defined by admins in Settings → Cards (migration 0021):
  create a property with a label, a type (text, number, select, multi-select,
  date, or person), options where relevant, and the hierarchy levels it
  applies to. Values are edited on each item's page and the board drawer, and
  can be shown on board cards. Properties previously came from the repo's
  `.specboard/config.yml`; the database is now the single source and the
  `fields`/`estimate` config keys are ignored.
- Releases (migration 0021): a workspace-wide record with a name, status
  (planned/in progress/shipped), and optional target date. Items are
  scheduled into a release from their detail page or the board drawer. The
  Roadmap now groups items by release (dated releases first, "Unscheduled"
  last) and admins create or delete releases right from the Roadmap. The
  backlog list gains a release filter and a Release column.
- Item pages have a dedicated Relationships section combining the parent
  picker, the children list with roll-up progress, and the typed links
  (blocks/relates/duplicates), previously split between the metadata sidebar
  and a hierarchy block.

### Changed

- Cards start lean: every level now carries name, status, assignee, and tags
  only. The built-in priority, estimate, and roadmap quarter fields are
  removed (migration 0021 drops the columns; recreate any of them as custom
  properties if needed). Backlog ordering falls back to manual board rank,
  then title. The CLI's `priority` command is gone.
- The Backlog and Roadmap now open on the Feature level by default
  (previously the leaf Work Item level). The `?level=` switcher works as
  before.
- Per-level field availability (Settings → Cards) now covers the built-in
  assignee and tags fields; custom-property availability lives on the
  property itself. Existing per-level selections were reset to "all".

## [0.3.0] - 2026-07-03

### Added

- Settings → Cards (renamed from "Work cards"): admins choose which metadata
  fields (priority, estimate, assignee, roadmap quarter, tags, and custom
  fields) are available at each hierarchy level. Levels with no restriction
  automatically pick up new custom fields. Stored per level (migration 0020)
  and enforced in the metadata form on the item page and the board drawer.
- The workspace's dedicated spec repository (created by the one-click
  onboarding flow) is now marked as such (migration 0020) and shown with a
  "(spec repo)" tag.

### Changed

- Work item details are organized into three collapsible sections: Metadata,
  Details (the spec content), and Integrations (GitHub links). Collapsed or
  expanded state is remembered between sessions. The board's edit drawer uses
  the same Metadata and Integrations sections.
- Metadata on cards now saves automatically: selects commit on change and
  text fields when you pause or leave them. The "Save metadata" button is
  gone; a subtle Saving/Saved indicator replaces it.
- The guided "create your first spec" walkthrough now targets the dedicated
  spec repo by default (previously it defaulted to the first connected
  repository, which could silently commit the starter spec into an
  application repo), lists the spec repo first in the picker, and names the
  repository it committed to in the confirmation.
- The "Prefer a dedicated repo just for specs?" instructions disappear from
  the first-spec walkthrough once a dedicated spec repo exists.

### Fixed

- Saving metadata on cards no longer fails with a 500 on hosted deployments:
  the app's row-level-security database role was missing SELECT on `users`,
  which the assignee validation introduced in 0.2.0 reads. (Database grant,
  applied to both test and production.)

## [0.2.2] - 2026-07-03

### Fixed

- Signing up with an email that already has an account now sends that address
  a "you already have an account" email pointing at sign-in and password
  reset. Previously the attempt was answered with a generic success (correct,
  it prevents account enumeration) but nothing was delivered, so the
  legitimate owner waited for a verification email that never came. The
  "Check your email" notice copy no longer promises a verification link
  specifically.
- Auth rate limiting now resolves the real client IP from Fly's
  `Fly-Client-IP` header. Behind Fly's proxy it previously fell back to a
  single shared per-path bucket for all visitors, so a handful of sign-in
  attempts from anyone could rate-limit everyone.

## [0.2.1] - 2026-07-03

### Changed

- Dark mode now carries a deep blue tint instead of neutral gray, aligning
  the theme with the Specboard brand. Surface lightness is unchanged, so
  contrast is unaffected.

## [0.2.0] - 2026-07-03

### Added

- One-click dedicated spec repo creation during onboarding: for organization
  installations, Specboard creates a private repo, connects it, and hands off
  to the first-spec walkthrough to seed it. Requires the GitHub App's
  repository Administration (write) permission; the self-host manifest now
  requests it, and hosted Apps need it added in GitHub. Personal-account
  installations keep the manual deep-link steps.
- The connect picker's repository list is prefetched server-side, so it
  renders with the initial HTML instead of popping in after a client fetch;
  loading states now use skeletons.

### Changed

- GitHub App installations are persisted in a workspace-scoped
  `github_installations` table (migration 0019) instead of a 15-minute signed
  cookie, so the connect picker, repo creation, and repo connect work on any
  later visit. Multiple installations per workspace are supported, uninstall
  webhooks drop the binding, and stale rows self-heal on read.

### Security

- Hardened the app surface ahead of an external pen test: security headers
  (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy),
  Better Auth rate limiting with stricter credential-path rules, a non-root
  runtime container, and a CSRF nonce on the GitHub App install round-trip.
- Closed cross-tenant defense-in-depth gaps: webhooks reconcile every
  workspace that connected a repo, assignee and product-member targets are
  validated as workspace members, and changing a product's visibility is
  restricted to org admins.
- Sturdier input handling: malformed percent-escapes no longer 500 the site,
  an unparseable spec is skipped instead of aborting the repo sync, and the
  untrusted repo config's globs and statuses are bounded to limit ReDoS.
- Provisioned (not yet activated) a non-owner `specboard_app` database role
  for the row-level-security cutover.

## [0.1.6] - 2026-07-01

### Fixed

- Deployed apps served a broken logo image on the sign-in and sign-up cards:
  the Docker runtime image did not include the `public` folder, which Next.js
  standalone output requires to be copied in manually, so every public asset
  returned 404 in cloud environments.

## [0.1.5] - 2026-07-01

### Added

- App branding from the new logo kit: favicon, apple touch icon, and social
  preview (Open Graph) image, plus the icon mark in the sidebar header and on
  the sign-in and sign-up cards.
- First automated end-to-end tests: a Playwright suite covering the onboarding
  spec flow (scan and import, guided first spec, dedicated-repo nudge), run in
  CI on every pull request and now a required check on `main`.

### Changed

- Brand spelling unified to "Specboard" (previously "SpecBoard") across the UI,
  docs, and emails.
- Dependencies updated to latest compatible versions (better-auth 1.6.23,
  Tailwind 4.3.2, lucide-react 1.23, vitest 3.2, turbo 2.10, prettier 3.9).
  The vitest bump moves the transitive vite past two security advisories.

### Fixed

- Flaky end-to-end setup: signing in raced the app's own redirect to `/setup`.

## [0.1.4] - 2026-07-01

### Added

- Onboarding spec flow. Connecting a repository now registers it without
  auto-importing; an "Import your specs" panel scans connected repos read-only
  for `spec.md` files and creates cards only after you confirm, then links to the
  board.
- Guided first spec. When connected repos have no specs, the empty state walks
  you through naming a feature and picking a repo, then commits a starter
  `specs/<feature>/spec.md` (stable id and template body) and imports it so a
  real card appears. Refuses to overwrite an existing file.
- "Prefer a dedicated repo just for specs?" nudge for users without a suitable
  repo: a prefilled link to create a `specs` repo on GitHub, then install,
  connect, and seed it through the existing flow. No new GitHub App permissions.

## [0.1.3] - 2026-06-30

### Added

- CLI: `specboard --version` (also `version` / `-v`) prints the released
  version, read from the package manifest at runtime.
- `VERSIONING.md` documenting the single-version monorepo scheme and the
  per-release increment rule, plus this changelog.

### Fixed

- GitHub App install: a stray trailing space in the hand-configured "Setup URL"
  made GitHub redirect post-install to `/api/v1/github/setup%20`, a 404.
  Middleware now normalizes any trailing-whitespace variant back to the real
  route, preserving the `installation_id` / `setup_action` query, so the connect
  flow lands on the Repositories page instead of a dead end.

## [0.1.0]

- Initial baseline: spec backlog, roadmap, GitHub sync, multi-tenant org model,
  programmatic API keys, and the `specboard` CLI.
