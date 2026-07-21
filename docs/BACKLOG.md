# Backlog

The implementation backlog now lives in **Specboards itself** (we dogfood our own
product), not in this repo. This file is a pointer.

## Where the backlog is

The connected Specboards workspace is **Specboard** (`app.specboards.ai`, workspace
slug `specboard`). Work is organized as Initiative -> Epic -> Feature -> Work Item.

To see the current state and the next items to pick up:

- **In the app:** open the Backlog / Board / Roadmap views for the Specboard
  workspace.
- **Via MCP** (Claude Code and other agents): call `whoami`, then `list_items`
  (optionally filtered by `status` or `product`), and `read_item` for full detail
  on a card.

## What's tracked there

**Initiative: Product roadmap (H2 2026)** - the PM table-stakes backlog migrated
from the old GitHub issue tracker. Epics: Planning & prioritization, Roadmap &
strategy, Collaboration & notifications, Analytics & reporting, Ideas & public
portal, UX & workflow, Work-tracking model. Each feature card carries its tier
(`tier-1` = highest) and area, and links back to its original GitHub issue.

**Initiative: Workspace & integrations administration** - the work of building
Specboards itself. Epics:

- **Product & integrations polish** - auto-grant product admin, repos under
  Integrations.
- **Security & platform hardening** - the open tails from the July 2026
  adversarial source review plus the RLS non-owner role cutover (the bulk of that
  review shipped in the v0.2.0 hardening pass).
- **Org provisioning & multi-tenant SaaS** - self-service org provisioning
  (ADR-0001 Phase 4).
- **Dogfood loop & public API** - productizing the PR -> work-item-status loop and
  closing the public REST API gaps.

## Historical planning docs

The design and plan docs whose content shipped or was migrated into Specboards live
in [`docs/archive/`](./archive/) for reference. Active operational runbooks stay in
`docs/` (`RUNBOOK-github-sync.md`, `RUNBOOK-specboard-dogfood.md`), and
architecture decisions stay in [`docs/adr/`](./adr/).
