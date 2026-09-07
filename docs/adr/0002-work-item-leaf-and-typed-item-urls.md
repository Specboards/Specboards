# ADR 0002: Work Item leaf + type-segmented item URLs

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Jonathan Butler
- **Supersedes:** ADR 0001 **D4** (identity in URLs) and **D6** (item URL shape)

## Context

ADR 0001 D4 declared "identity = the git spec id, the canonical route param,"
and D6 made the item permalink `/{org}/{product}/backlog/{specId}`. In practice
the hierarchy only spec-backs the **leaf** level: Initiative / Epic / Feature
are DB-native grouping records that have no spec and are given a *synthetic*
`specId` equal to their row id (`store/db.ts`, "row stays uniformly routable").

Two problems followed:

1. **"Spec id" is a misnomer for most items.** Calling a grouping's row id a
   "spec id" and framing identity as "the git spec id" only holds for the leaf.
2. **The URL hides the item's type.** `/backlog/{id}` gives no signal whether
   you're looking at an initiative, epic, feature, or a spec. It also conflated
   two kinds of identity (git spec id vs DB row id) behind one segment.

Separately, the product intent firmed up: **specs should describe work items**
that sit *under* features. Features (and everything above) are planning
groupings managed in the app, not synced from git, even when a feature has
just one work item.

## Decision

### D1. A spec-backed "Work Item" leaf beneath "Feature"
The default hierarchy becomes four levels: **Initiative → Epic → Feature →
Work Item**, where **Work Item is the only git-spec-backed level**. Feature is
demoted to an app-native grouping. This is a default-config change, not new
machinery. The level system (`packages/core/src/levels.ts`) already treats
"leaf = spec-backed, everything above = DB-native"; we add one level and let the
existing leaf-agnostic rules (`leafLevel`, `parentLevelKey`, `resolveLevelUpdate`)
apply to `work`.

Spec sync sets `features.level` explicitly to the workspace's leaf key rather
than relying on the column default, so the leaf can be renamed without drifting.

### D2. Type-segmented item URLs
The item permalink gains a **level-key segment**:

```
/{org}/{product}/backlog/{levelKey}/{specId}
  e.g. /acme/web/backlog/epic/{id}
       /acme/web/backlog/work/{specId}
```

The segment is always the item's **level key** (uniform across levels, leaf
included), so it stays correct when a workspace renames or adds levels. `{specId}`
remains the row's `specId` for every level (groupings keep `specId = id`), so
lookup is unchanged. The segment is a legibility + type hint that is validated
against the resolved row and redirected when stale.

### D3. Identity, restated
- **Leaf (Work Item):** identity is the **git spec id**: global, stable, never
  renumbered (the durable part of ADR 0001 D4).
- **Groupings (Initiative / Epic / Feature):** app-native, identified by their
  **DB id** (surfaced as `specId` for routing uniformity). These are not specs
  and carry no git identity.

### D4. Backward compatibility
The old shallow permalink `/{org}/{product}/backlog/{specId}` still resolves: a
single catch-all route (`backlog/[...slug]`) accepts one segment (bare specId)
and **redirects** to the canonical typed URL, and two segments (`[level, specId]`)
render the detail (redirecting if the level segment is stale). The Phase 3b
permalinks therefore keep working.

## Migration

For each existing workspace whose leaf is still `feature` (the old default):
add a `work` leaf, demote `feature` to a grouping, and **wrap each existing spec
1:1** in a new Feature grouping (inheriting the spec's former parent), moving the
spec down to `work`. See `infra/migrations/0014_work_item_leaf_backfill.sql`,
folded into `0000_baseline.sql` by the v1.0.2 squash and readable in git
history before that release.
Workspaces with a customized leaf are left untouched.

## Consequences

**Positive:** the model matches intent (specs = work items; planning levels live
in the app); URLs are type-legible and survive level renames; identity framing is
honest about git-backed vs app-native; old links still resolve.

**Negative / risks:** the 1:1 auto-wrap creates one Feature per existing spec
(acceptable, user-chosen; can be merged later); the item route is now a catch-all
(slightly more parsing); GitHub PR/issue/branch links still attach only to
spec-backed Work Items (groupings show inherited rollups). This is unchanged, but
worth restating since "epics link to PRs" is a common misconception.
