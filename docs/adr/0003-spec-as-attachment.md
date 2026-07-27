# ADR 0003: A spec is an attachment, not an identity

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Jonathan Butler
- **Completes:** ADR 0002 **D1** and **D3** (the Work Item leaf), whose intent was
  never finished in the implementation

## Context

ADR 0002 renamed the leaf level to **Work Item** and declared that specs
*describe* work items. The implementation stopped halfway: the leaf level is
still welded to git. Concretely, today:

- `createFeature` refuses any leaf-level create outright ("Leaf-level items come
  from specs and can't be created here"), in both stores.
- The only way to bring a leaf item into existence is `create_spec`: commit a
  `spec.md`, then sync it.
- `isDbNative` is derived as `features.repo_id === null`, and that one boolean
  gates title editing, body editing, and deletion.

A test customer runs a Feature whose child work is split between human engineers
and agents. Agent work has specs. Human work does not, and there is no honest
way to track it. The workaround is to write a spec file for a task no one will
ever read as a document, which is a fake artifact created purely to satisfy a
foreign key. Worse, teams that decline the workaround simply do not record the
human work, so the Feature's `childCount` / `childDoneCount` rollups, which are
the whole reason the hierarchy view is worth having, silently under-report.

The coupling turns out to be narrower than it looks. `features.repo_id` is
already nullable, `spec_index` is already a separate table joined on
`feature_id`, and a DB-native leaf row is therefore already *representable*. The
blocker is a guard, not a schema.

## Decision

**The Work Item is the unit of tracked work and is always a DB row. A spec is an
optional, git-backed document attached to a work item.**

"DB-native vs spec-backed" stops being two kinds of item and becomes one
question about one item: does it have a spec attached?

### D1. One owner per field

When a work item has a spec, ownership splits and never overlaps:

| Field | Owner | Why |
| --- | --- | --- |
| status, assignee, relations, parent, release, cycle, tags, custom fields, RICE | **Work item (DB)** | Planning metadata a PM changes in the app; git is the wrong round trip |
| Document body, sections | **Spec (git)** | The spec is the document; git is canonical for it |
| Title | **Work item (DB)**, synced *from* frontmatter when a spec is attached | One title, one place to read it |

Title is the only field that needs a rule rather than a column. A work item with
no spec owns its title outright and can be renamed in the app. A work item with
a spec attached takes its title from the spec's frontmatter on each sync, and
the app refuses an in-app rename with a message pointing at git. This is the
existing behaviour, now stated as a consequence of attachment rather than of
`repo_id`.

### D2. `isDbNative` means "has no spec", derived from `spec_index`

Once a leaf row can exist with `repo_id === null`, the old derivation breaks:
`repo_id === null` starts meaning "has no repo" and stops meaning "has no spec".
Those two propositions were accidentally identical only because the leaf guard
made a repo-less leaf impossible.

The derivation moves to **presence of a `spec_index` row for the feature**.
Both `listFeatures` and `getFeature` already load that relation (`with: { index:
true }`), so this is a change of expression, not of query cost.

This rename is the real work of lifting the guard. Every consumer of
`isDbNative` (title guard, body editing, `update_spec_content`'s rejection,
delete semantics) is asking "does this item have a document in git?", and every
one of them gets the right answer from `spec_index` and the wrong answer from
`repo_id` the moment a human work item exists.

`isDbNative` is retained as the field name rather than renamed to `hasSpec` (or
inverted) because it is on the public REST and MCP surface and in the published
CLI's response type. Renaming it is a breaking change for a cosmetic gain. Its
*meaning* is now documented as "no attached spec".

### D3. A spec attaches to an existing work item

`create_spec` takes an optional work item to attach to. When given one, it
writes `spec.md` with **that item's `specId`** in frontmatter and links a
`spec_index` row to the existing row. It does not create a second row.

Sync therefore has exactly two cases, and no third:

1. The spec's frontmatter id matches an existing work item in the workspace:
   **update** that item (title, body, index) and attach if not already attached.
2. It matches nothing: **create** a work item for it, as sync does today.

The auto-created Feature *wrapper* (`featureKeyFor`, one grouping per spec
folder) is retired. It existed to give an imported spec a parent when the spec
was the only way to create a leaf item. A spec attached to an item the user
already placed in the hierarchy needs no wrapper, and wrappers created for
unattached imports are a known source of orphans. Sync still homes a genuinely
new import under a grouping; it never re-homes or wraps an item that already has
a parent.

### D4. Delete is allowed, and takes the spec file with it

`delete_item` currently refuses any spec-backed item outright. Under attachment
semantics that blanket refusal is wrong, but the obvious replacement, "delete
the row and leave the file", is worse: sync would re-import the spec on its next
run and recreate the item with default status, assignee, and parent. The delete
would appear to succeed and then silently undo itself, losing the metadata on
the way.

So deleting a work item that has a spec attached requires the caller to say so
explicitly (`removeSpec`), and when they do, the git file is deleted in the same
operation, before the row. Without that opt-in the delete is refused, with a
message that says why rather than the old "spec-backed items can't be deleted
here".

A work item with no spec deletes through the ordinary item controls, with no
special case and no opt-in.

The asymmetry with D1 is deliberate. Ownership splits per *field* while both
records exist; deletion ends the item's existence, and an attached document
outliving the work it documented is not a state worth being able to reach by
accident.

### D5. Done is defined once, at the work-item level

Rollups (`childCount` / `childDoneCount`, release progress, goal progress) count
work items and ask each one whether its status is terminal. They do not ask
whether it has a spec. A Feature holding one human work item and one agent spec
rolls up as 2, and marking either done moves it to 1 of 2.

This is already how the rollup code works. It is stated here because it is the
property that made the whole change worth doing, and any future divergence, such
as weighting spec-backed work differently, would break the customer case that
motivated it.

### D6. Positioning stays coherent

"Git is canonical for your specs" remains true, and is now precise: it is
canonical for items that *have* specs. Human work items are DB-canonical and
always were, at every level above the leaf. The self-host and git-purist story
is unchanged for anyone who wants every work item spec-backed; they simply
attach a spec to each one, which is what they already do.

What we give up is the guarantee that the leaf level is fully reconstructible
from a git checkout. That guarantee was already false for Initiative, Epic, and
Feature, and for every piece of planning metadata on a spec-backed leaf
(status, assignee, release). The database was already the system of record for
tracking; this decision stops pretending otherwise at one level.

## Consequences

**Positive.** Human and agent work sit side by side under one Feature and roll
up honestly. Leaf items can be created from the board, the list, the REST API,
and MCP like any other level. The fake-artifact tax is gone. `isDbNative` means
one thing again. The wrapper-orphan class of bug is removed at its source rather
than pruned after the fact.

**Negative / risks.**

- `isDbNative` now reads "no attached spec" while its name says "DB-native".
  Kept deliberately (D2); the name is load-bearing on a public API.
- A workspace can now hold two leaf items that look alike, one with a spec and
  one without. That is the point, but it means "why can't I rename this one?"
  becomes a question the UI has to answer rather than a rule that applies to a
  whole level. The detail view states the reason inline.
- Delete (D4) is a genuine loosening: an item that could not be deleted before
  now can be, and doing so removes a file from a git repository. It is gated on
  an explicit opt-in and on product-write access, and it is the one place where
  an app action deletes committed content.
- Retiring the wrapper (D3) changes where freshly imported specs land for
  workspaces that relied on folder grouping. Existing wrappers are left in place
  and keep working; only new imports take the new path.
