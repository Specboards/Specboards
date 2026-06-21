# Product Management Backlog — Table Stakes

This backlog captures the product-management features SpecBoard needs to flush out its
**core use case**: PM / UX / Eng collaborating to **prioritize and define git-backed specs
that AI agents consume**. The list comes from a competitive feature review of **Linear,
Jira, Aha!, and Productboard** (2025–2026), filtered to what is genuinely *table stakes*
for SpecBoard rather than each tool's differentiators.

Each item below is tracked as a GitHub issue under the
[**PM table stakes** milestone](https://github.com/Specboards/SpecBoard/milestone/1)
and tagged with a `tier-*` and `area:*` label.

## What SpecBoard already has

Backlog / Board / Roadmap (by quarter) views · 5-stage status workflow · assignee ·
priority · manual rank · tags · custom fields · per-feature comments · activity log ·
drag-and-drop board (status + reorder) · in-context card editing · per-user
customizable card fields · configurable multi-level hierarchy (Initiative → Epic →
Feature → Work Item) · multi-product backlogs under `/{org}/{product}/` · GitHub sync
(specs auto-homed under Feature groupings) · GitHub PR/issue/branch links on features ·
MCP server for agents.

The backlog below is the **gap** between that and what the four reference tools treat as baseline.

## Progress

- ✅ **#16 Dependencies & relations** — shipped (typed `feature_links`: blocks /
  blocked-by / relates-to / duplicates; feature-detail editor; "Blocked" badge on
  board & backlog; `get_relations` + `blocks`/`blockedBy` in MCP). Migration
  `0004` applied to **test** and **prod**.
- ✅ **#15 Spec hierarchy** — shipped (self-referential `parent_id`; parent/child
  roll-up progress; cycle-safe reparenting; Parent selector + Hierarchy section on
  the feature detail; nested rows + "epic n/m" badge on backlog; epic/sub badges on
  board; parent/children in MCP). Migration `0005` applied to **test** and **prod**.
  Follow-ups now shipped: per-epic collapse/expand toggle on the nested backlog
  (persisted in localStorage); Parent picker excludes the feature's own
  descendants so the UI can't offer a cycle.
- ✅ **#20 Estimate/effort field** — shipped (workspace-configurable numeric
  `estimate.scale` on RepoConfig, Fibonacci default; nullable `estimate` column;
  `rollUpEstimates` summing each subtree; estimate select on the feature detail +
  "Est" column on backlog and badge on board, both showing the Σ roll-up for
  epics; `estimate`/`rolledEstimate` in MCP `list_features`/`read_spec`).
  Migration `0006` applied to **test** and **prod**.
- ✅ **#17 Filtering & saved custom views** — shipped (URL-backed filter bar on
  the backlog: status/assignee/priority/tag/parent, filtering flattens the
  hierarchy; per-user **saved views** — `saved_views` table with workspace RLS,
  store methods on db + local, `/api/v1/views` GET/POST/DELETE, SavedViews chip
  bar; local mode persists to gitignored `.specboard/local-views.json`).
  Migration `0007` applied to **test** and **prod**.
- ✅ **#18 Customizable workflow statuses** — shipped (config-driven via
  `.specboard/config.yml` `statuses`/`transitions`, which RepoConfig already
  carried; `resolveWorkflow` in core; board columns, backlog status filter,
  inline status selects, and transition validation on both the web service and
  MCP `update_status` all honor the workspace workflow; custom statuses get a
  stable dot color). **No DB migration** — the default workflow applies when a
  repo sets nothing, so existing data is unaffected.
- Rows below are marked ✅ when done.

## Next steps

**Phase 3 — configurable work-tracking hierarchy (✅ shipped, from user research).**
Teams choose their depth: **Initiative → Epic → Feature**, renamed/trimmed per
workspace. Higher levels are **DB-native, workspace-scoped, repo-agnostic** records
(`features.repo_id` nullable; a `level` column + a `workspace_levels` config table);
the leaf stays the git-backed spec. Reuses the existing `parent_id` chain, estimate
roll-up, and the Phase 2 GitHub-link roll-up (already level-agnostic). See the
"post-research" section below for the as-built breakdown across PRs.

**Table-stakes order** (next up first). #15, #16, #17, #18, and #20
are done, so the remaining Tier 1 work:

1. **#19 @mentions + notification inbox** — last Tier 1 item; collaboration glue.
   New `notifications` table + mention parsing on comments + an inbox UI.
2. **#24 Bulk operations** — leans on #15 (bulk reparent) and #17 (select-all-in-filter).
3. **#21 Prioritization scoring** — best after #20 (uses estimate as the effort term).

Then proceed down Tiers 2–3 in the tables below. Re-confirm priority with the team
before starting each item.

**Open follow-ups on shipped work**

- **#15** — none outstanding (collapse/expand toggle + cycle-safe Parent picker shipped).
- **#16** — none outstanding.
- **#20** — none outstanding; migration `0006` applied to test + prod.
- **#17** — none outstanding; migration `0007` applied to test + prod. Possible
  follow-ups (not blocking): multi-select filters; extend the filter bar to the
  board; shared (team) views in addition to personal.
- **#18** — none outstanding. Possible follow-ups (not blocking): a Settings UI
  to edit statuses without hand-editing `config.yml`; make the roll-up "done"
  status configurable (it currently keys on the literal `done`).

### Post-research UX & integration work (2026-06-18)

Driven by user testing rather than the table-stakes milestone; shipped to **test + prod**.

- **Phase 1 — Board UX overhaul** (PR #35) — drag-and-drop board via `@dnd-kit`:
  cross-column drops change status (validated by the existing workflow state machine),
  within-column drops persist a fractional `rank` (the previously-unused `features.rank`,
  ordered with `fractional-indexing`). In-context editing: clicking a card opens a
  Radix **Sheet** drawer reusing `FeatureMetaForm`; `sonner` toasts added. Per-user
  **customizable card fields** + a "featured" custom field, stored in a new
  `board_preferences` table (workspace+user, RLS); defaults reproduce the old board.
  Migration `0008` applied to **test** and **prod**.
- **Phase 2 — GitHub feature linking** (PR #36) — link a feature to a GitHub
  **PR / issue / branch** (`feature_github_links` table, RLS; cached title/state/url).
  Links are stored on the work-item (spec) and **rolled up to the feature/epic above**
  for display (descendants shown as "inherited"); linkable at any level. `GitHubRepoClient`
  gains `getPullRequest`/`getIssue`/`getBranch`; the webhook now handles `pull_request`/`issues`
  events to refresh cached state (open → merged/closed), and the App manifest subscribes to
  them (+`issues:read`). Editor in the detail sidebar + board drawer; optional "GitHub" card
  field. The link row references an item id, so it's **hierarchy-ready for the planned levels
  work** with no schema change. Migration `0009` applied to **test** and **prod**.
  Operational follow-up: existing GitHub App installations must update their event
  subscriptions (in GitHub App settings) to receive `pull_request`/`issues` deliveries — new
  installs get them automatically. Manual linking + cached-state-on-create work regardless.
- **Phase 3a — left sidebar nav + Settings restructure + theme/profile** (PR #38) —
  replaced the top bar with a left sidebar (Strategy/Research "soon", Work → Ideas/Board/
  Roadmap, Settings); consolidated Backlog + Board under one "Board" nav entry with a view
  toggle; moved repo/company/work-card/branding into `/settings/*`; added light/dark theme
  (`next-themes`) and profile name/avatar/**timezone** (Better Auth `additionalFields`).
  Migration `0010` (users `timezone`) applied to **test** and **prod**.
- **Phase 3b — configurable hierarchy model, backend** (PR #39) — `workspace_levels`
  table (RLS, seeded per workspace), `features.level` as a composite FK to it,
  `repo_id` nullable for DB-native items; `@specboard/core` levels module (depth,
  leaf, parent/child rules) + create/delete/list-levels on both stores and `/api/v1`.
  Migration `0011` applied to **test** and **prod**.
- **Phase 3c — level UX** (this PR) — **level switcher** (Initiative/Epic/Feature) on
  Board + Roadmap (`?level=`, default leaf); **create/rename/delete** of DB-native
  initiatives/epics from the board/roadmap header + feature detail (level-aware parent
  pickers; spec-backed titles stay read-only); feature detail renders DB-native items
  without spec content; **Settings → Hierarchy** editor to rename levels, add intermediate
  levels, and trim depth (leaf pinned; a level can't be removed while items use it).
  `resolveLevelUpdate` in core enforces the rules; `updateLevels` on both stores +
  admin-gated `PUT /api/v1/levels`. **No migration** (UI/validation only over 3a/3b).

**Build pattern to follow** (used for #15/#16/#20; keeps changes green and reviewable):
`packages/db` schema + generated migration (add RLS for any new tenant table) →
`apps/web/src/lib/store` types + **both** the `db` and `local` stores →
`features-service` validation → `/api/v1` route(s) → `api-client` →
feature-detail/board/backlog UI → `apps/mcp` enrichment → `pnpm typecheck && pnpm test
&& pnpm build` → smoke-test in local file mode → **apply the migration to test + prod**.

Applying the migration is part of shipping the feature, **not** a deferred step —
a branch isn't done until its migration is live on both databases (there's no
release_command, so an unapplied migration breaks the next deploy). Migrations are
not auto-applied on deploy, so per cluster (test `z7y24od8vemrgqd1`, prod
`1zqyxr7d791rwp8m`):

1. `fly mpg status <cluster-id> --json` → `.credentials` (user `fly-user`, password, db `fly-db`).
2. `fly mpg proxy <cluster-id> -p 16380` (background; one cluster at a time).
3. `DATABASE_URL='postgres://fly-user:<pass>@127.0.0.1:16380/fly-db?sslmode=disable' pnpm --filter @specboard/db migrate`.
4. Verify the change via `psql` over the proxy, then stop the proxy. Test first, then prod.

**Repo hygiene**

- ✅ #15/#16/#17/#18/#20 merged to `main` via **PR #33**
  (`feat/pm-table-stakes`, now deleted); issues #15, #16, #17, #18, #20 closed.
- The old `feat/email-verification-github-sync` remote branch is redundant (its
  auth/GitHub-sync namesake is already on `main`) and can be deleted on the remote.
- `pnpm lint` is broken environment-wide (`eslint` not installed) — run `pnpm install`
  to restore it; build/typecheck/test are the working gates today.

## Prioritization tiers

- **Tier 1 — Core PM table stakes.** Most essential to the prioritize/define-specs use case; the
  backlog is hard to run at scale without them. Build first.
- **Tier 2 — Strongly expected.** Baseline across the comparison set; expected by any PM evaluating SpecBoard.
- **Tier 3 — Differentiators / later.** Valuable, often signature capabilities of one tool; sequence after Tiers 1–2.

---

## Tier 1 — Core PM table stakes

| # | Feature | Why it's core | Seen in |
|---|---------|---------------|---------|
| [#15](https://github.com/Specboards/SpecBoard/issues/15) ✅ | **Spec hierarchy** — group features under epics/initiatives with roll-up progress | Flat lists don't scale; organizing specs is foundational | Linear sub-issues, Jira epics, Aha! master features, PB components |
| [#16](https://github.com/Specboards/SpecBoard/issues/16) ✅ | **Dependencies & relations** (blocks / blocked-by / relates-to) | Encodes the *sequence* agents must follow — the most use-case-critical gap | All four |
| [#17](https://github.com/Specboards/SpecBoard/issues/17) ✅ | **Filtering & saved custom views** | Navigating a growing backlog is impossible without it | All four (Jira JQL, Linear views) |
| [#18](https://github.com/Specboards/SpecBoard/issues/18) ✅ | **Customizable workflow statuses** per workspace | Fixed 5 statuses don't fit real definition/review processes | All four |
| [#19](https://github.com/Specboards/SpecBoard/issues/19) | **@mentions + notification inbox** | PM/UX/Eng collaboration breaks down without it | All four |
| [#20](https://github.com/Specboards/SpecBoard/issues/20) ✅ | **First-class estimate/effort field** with roll-up | Underpins capacity reasoning and prioritization | Linear/Jira points, Aha!/PB effort |

## Tier 2 — Strongly expected

| # | Feature | Why | Seen in |
|---|---------|-----|---------|
| [#21](https://github.com/Specboards/SpecBoard/issues/21) | **Prioritization scoring** (RICE / value-vs-effort) | Turns prioritization from opinion into a defensible ranking — the core PM job | Aha! scorecard, PB drivers |
| [#22](https://github.com/Specboards/SpecBoard/issues/22) | **Command palette (Cmd-K) + keyboard shortcuts** | Expected baseline UX for a daily-driver tool | Linear (signature) |
| [#23](https://github.com/Specboards/SpecBoard/issues/23) | **Milestones / releases** with target dates | Plan/communicate delivery beyond coarse quarters | Jira versions, Aha! releases, Linear milestones, PB now/next/later |
| [#24](https://github.com/Specboards/SpecBoard/issues/24) | **Bulk operations** | Backlog grooming is too slow one-at-a-time | Linear, Jira |
| [#25](https://github.com/Specboards/SpecBoard/issues/25) | **Due/target dates** on features | Baseline field; feeds the timeline view | All four |
| [#26](https://github.com/Specboards/SpecBoard/issues/26) | **Roadmap timeline / Gantt view** | Visualize sequencing over time | Linear timeline, Jira, Aha! Gantt |

## Tier 3 — Differentiators / later

| # | Feature | Why | Seen in |
|---|---------|-----|---------|
| [#27](https://github.com/Specboards/SpecBoard/issues/27) | **Goals / initiatives / OKR linkage** | Strategy-to-execution traceability | Aha! (core), PB objectives, Linear initiatives |
| [#28](https://github.com/Specboards/SpecBoard/issues/28) | **Cycles / sprints / iterations** | Execution cadence + velocity tracking | Linear cycles, Jira sprints, Aha! Develop |
| [#29](https://github.com/Specboards/SpecBoard/issues/29) | **Idea & feedback capture + voting**, linked to specs | Demand evidence drives spec prioritization | PB insights, Aha! ideas (both signature) |
| [#30](https://github.com/Specboards/SpecBoard/issues/30) | **Reporting & analytics** (velocity, burndown, cycle time) | Understand delivery health | All four |
| [#31](https://github.com/Specboards/SpecBoard/issues/31) | **Slack integration** | Meet teams where they work | Linear, Jira, PB |
| [#32](https://github.com/Specboards/SpecBoard/issues/32) | **Public read-only roadmap / portal** | Share plans with customers/stakeholders | Aha!, PB, Linear |

---

## Notable items deliberately **not** in scope (each tool's differentiators, not table stakes)

These are what make each tool distinctive but are **not** required to flush out SpecBoard's
core use case. Revisit only if they become strategically central.

- **Linear:** AI triage / dedup, Cycle Autopilot, Linear Asks (internal request mgmt), SLAs.
- **Jira:** JQL power-query language, the Marketplace ecosystem, deep scheme configurability, Jira Align / SAFe, Rovo AI.
- **Aha!:** strategy models/templates, configurable value scorecard depth, presentation/whiteboard suite, proxy voting, capacity planning.
- **Productboard:** multi-source feedback ingestion breadth, Customer/User Impact Score, Pulse (VoC AI) and Spark (PM agent), segment/cohort analytics.

> SpecBoard's own differentiator remains specs-stay-in-git + metadata-in-DB + MCP for agents.
> The backlog above is about reaching parity on the PM *fundamentals*, not chasing each tool's edge.

## Source review

Competitive inventories that informed this backlog were compiled from each vendor's current
docs and changelogs (Linear, Atlassian/Jira, Aha!, Productboard) in June 2026. The full
per-tool feature inventories live in the review that generated this document.
