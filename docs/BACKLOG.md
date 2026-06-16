# Product Management Backlog — Table Stakes

This backlog captures the product-management features SpecBoard needs to flush out its
**core use case**: PM / UX / Eng collaborating to **prioritize and define git-backed specs
that AI agents consume**. The list comes from a competitive feature review of **Linear,
Jira, Aha!, and Productboard** (2025–2026), filtered to what is genuinely *table stakes*
for SpecBoard rather than each tool's differentiators.

Each item below is tracked as a GitHub issue under the
[**PM table stakes** milestone](https://github.com/StudioPalouse/SpecBoard/milestone/1)
and tagged with a `tier-*` and `area:*` label.

## What SpecBoard already has

Backlog / Board / Roadmap (by quarter) views · 5-stage status workflow · assignee ·
priority · manual rank · tags · custom fields · per-feature comments · activity log ·
GitHub sync · MCP server for agents.

The backlog below is the **gap** between that and what the four reference tools treat as baseline.

## Prioritization tiers

- **Tier 1 — Core PM table stakes.** Most essential to the prioritize/define-specs use case; the
  backlog is hard to run at scale without them. Build first.
- **Tier 2 — Strongly expected.** Baseline across the comparison set; expected by any PM evaluating SpecBoard.
- **Tier 3 — Differentiators / later.** Valuable, often signature capabilities of one tool; sequence after Tiers 1–2.

---

## Tier 1 — Core PM table stakes

| # | Feature | Why it's core | Seen in |
|---|---------|---------------|---------|
| [#15](https://github.com/StudioPalouse/SpecBoard/issues/15) | **Spec hierarchy** — group features under epics/initiatives with roll-up progress | Flat lists don't scale; organizing specs is foundational | Linear sub-issues, Jira epics, Aha! master features, PB components |
| [#16](https://github.com/StudioPalouse/SpecBoard/issues/16) | **Dependencies & relations** (blocks / blocked-by / relates-to) | Encodes the *sequence* agents must follow — the most use-case-critical gap | All four |
| [#17](https://github.com/StudioPalouse/SpecBoard/issues/17) | **Filtering & saved custom views** | Navigating a growing backlog is impossible without it | All four (Jira JQL, Linear views) |
| [#18](https://github.com/StudioPalouse/SpecBoard/issues/18) | **Customizable workflow statuses** per workspace | Fixed 5 statuses don't fit real definition/review processes | All four |
| [#19](https://github.com/StudioPalouse/SpecBoard/issues/19) | **@mentions + notification inbox** | PM/UX/Eng collaboration breaks down without it | All four |
| [#20](https://github.com/StudioPalouse/SpecBoard/issues/20) | **First-class estimate/effort field** with roll-up | Underpins capacity reasoning and prioritization | Linear/Jira points, Aha!/PB effort |

## Tier 2 — Strongly expected

| # | Feature | Why | Seen in |
|---|---------|-----|---------|
| [#21](https://github.com/StudioPalouse/SpecBoard/issues/21) | **Prioritization scoring** (RICE / value-vs-effort) | Turns prioritization from opinion into a defensible ranking — the core PM job | Aha! scorecard, PB drivers |
| [#22](https://github.com/StudioPalouse/SpecBoard/issues/22) | **Command palette (Cmd-K) + keyboard shortcuts** | Expected baseline UX for a daily-driver tool | Linear (signature) |
| [#23](https://github.com/StudioPalouse/SpecBoard/issues/23) | **Milestones / releases** with target dates | Plan/communicate delivery beyond coarse quarters | Jira versions, Aha! releases, Linear milestones, PB now/next/later |
| [#24](https://github.com/StudioPalouse/SpecBoard/issues/24) | **Bulk operations** | Backlog grooming is too slow one-at-a-time | Linear, Jira |
| [#25](https://github.com/StudioPalouse/SpecBoard/issues/25) | **Due/target dates** on features | Baseline field; feeds the timeline view | All four |
| [#26](https://github.com/StudioPalouse/SpecBoard/issues/26) | **Roadmap timeline / Gantt view** | Visualize sequencing over time | Linear timeline, Jira, Aha! Gantt |

## Tier 3 — Differentiators / later

| # | Feature | Why | Seen in |
|---|---------|-----|---------|
| [#27](https://github.com/StudioPalouse/SpecBoard/issues/27) | **Goals / initiatives / OKR linkage** | Strategy-to-execution traceability | Aha! (core), PB objectives, Linear initiatives |
| [#28](https://github.com/StudioPalouse/SpecBoard/issues/28) | **Cycles / sprints / iterations** | Execution cadence + velocity tracking | Linear cycles, Jira sprints, Aha! Develop |
| [#29](https://github.com/StudioPalouse/SpecBoard/issues/29) | **Idea & feedback capture + voting**, linked to specs | Demand evidence drives spec prioritization | PB insights, Aha! ideas (both signature) |
| [#30](https://github.com/StudioPalouse/SpecBoard/issues/30) | **Reporting & analytics** (velocity, burndown, cycle time) | Understand delivery health | All four |
| [#31](https://github.com/StudioPalouse/SpecBoard/issues/31) | **Slack integration** | Meet teams where they work | Linear, Jira, PB |
| [#32](https://github.com/StudioPalouse/SpecBoard/issues/32) | **Public read-only roadmap / portal** | Share plans with customers/stakeholders | Aha!, PB, Linear |

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
