/**
 * Items: the write side, plus relations, GitHub links and the change ledger.
 *
 * Every mutation here does two things in one transaction: the change, and the
 * record of it. `writeItemEvents` appends one ledger row per field rather than
 * one per request, because a patch that moves an item's status and reassigns
 * it is two changes, and reverting or reporting on either one separately is
 * the whole point. A request that changes nothing writes nothing, so re-saving
 * a form does not pad the history.
 *
 * `listItemEvents` and `itemActivitySummary` read that ledger. They sit here
 * rather than in a domain of their own, which is what the interface says too:
 * the ledger has no meaning apart from the writes that fill it. The section
 * banner used to note that they sat in the wrong *order*, between
 * `addGithubLink` and `removeGithubLink`; they are now after the writes they
 * report on.
 *
 * `itemActivitySummary` aggregates in Postgres rather than reading rows into
 * memory. It is the one caller whose result set grows without bound as a
 * workspace is used, and a report that works for a month and dies at a year is
 * not a report.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";

import {
  canReadProduct,
  isGeneratedGroupingTitle,
  isValidParentLevel,
} from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import {
  and,
  comments,
  cycles,
  desc,
  eq,
  featureGithubLinks,
  featureLinks,
  features,
  inArray,
  itemEvents,
  or,
  releases,
  repositories,
  specIndex,
  sql,
} from "@specboards/db";

import {
  FeatureError,
  RelationError,
  type ActivityQuery,
  type ActivitySummary,
  type CreateFeatureInput,
  type FeatureRecord,
  type ItemEvent,
  type RelationInput,
  type ResolvedGithubLink,
  type ActorType,
  type DeleteFeatureOptions,
  type FeaturePatch,
  type OutboxEmit,
  type WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  canWriteProductId,
  emptyAgg,
  toCustomFields,
  type DbStoreContext,
  type LinkRow,
  type Tx,
} from "./context";

/**
 * The status a sync-created Feature grouping carries. Sync's insert does not
 * set `status`, so the row takes the `features.status` column default; a
 * grouping still sitting at this value has never been moved by anyone.
 */
/** One field's change, as the ledger records it. */ /** One field's change, as the ledger records it. */
interface ItemFieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** Defaults to "item.field_changed". */
  type?: string;
}

/**
 * The item columns whose changes are worth remembering.
 *
 * `rank` is deliberately absent. It is board ordering, rewritten every time
 * anyone drags a card, and recording it would bury the changes people actually
 * mean by "who changed what" under thousands of rows that answer nobody's
 * question. `updatedAt` and `parentSetBy` are bookkeeping the change itself
 * implies, so they are not changes in their own right.
 */
const LEDGER_FIELDS = [
  "title",
  "status",
  "tags",
  "releaseId",
  "cycleId",
  "assigneeId",
  "customFields",
  "details",
  "parentId",
  "riceReach",
  "riceImpact",
  "riceConfidence",
  "riceEffort",
] as const;

/**
 * Compare a stored value with the one about to replace it.
 *
 * Tags and custom fields are arrays and objects, so identity is the wrong test
 * and would log a change every time a form round-trips an unmodified list.
 * Serializing is enough here because these are plain JSON values with stable
 * key order from the same code path on both sides.
 */
function sameLedgerValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (
    before === null ||
    after === null ||
    before === undefined ||
    after === undefined
  ) {
    return (before ?? null) === (after ?? null);
  }
  if (typeof before === "object" || typeof after === "object") {
    return JSON.stringify(before) === JSON.stringify(after);
  }
  return false;
}

/**
 * The status a sync-created Feature grouping carries. Sync's insert does not
 * set `status`, so the row takes the `features.status` column default; a
 * grouping still sitting at this value has never been moved by anyone.
 */
const SYNC_CREATED_STATUS = "backlog";

/** The item a ledger row is about, snapshotted as it was when it changed. */
interface ItemEventSubject {
  featureId: string;
  specId: string;
  title: string | null;
  productId: string | null;
}

/**
 * Which of the tracked fields this write actually changes.
 *
 * Driven by what is in `set` (the columns the update will really write) rather
 * than by the caller's patch, so a value the store normalized or ignored does
 * not get recorded as a change that never happened.
 */
function ledgerChanges(
  current: Record<string, unknown>,
  set: Record<string, unknown>,
): ItemFieldChange[] {
  const changes: ItemFieldChange[] = [];
  for (const field of LEDGER_FIELDS) {
    if (!(field in set)) continue;
    const before = current[field];
    const after = set[field];
    if (sameLedgerValue(before, after)) continue;
    changes.push({ field, before: before ?? null, after: after ?? null });
  }
  return changes;
}

/** Map a viewer-relative direction to a canonical stored edge. */
function toEdge(
  selfId: string,
  otherId: string,
  direction: RelationInput["direction"],
): { fromFeatureId: string; toFeatureId: string; type: LinkRow["type"] } {
  switch (direction) {
    case "blocks":
      return { fromFeatureId: selfId, toFeatureId: otherId, type: "blocks" };
    case "blocked_by":
      return { fromFeatureId: otherId, toFeatureId: selfId, type: "blocks" };
    case "relates_to":
      return {
        fromFeatureId: selfId,
        toFeatureId: otherId,
        type: "relates_to",
      };
    case "duplicates":
      return {
        fromFeatureId: selfId,
        toFeatureId: otherId,
        type: "duplicates",
      };
  }
}

export async function createFeature(
  ctx: DbStoreContext,
  input: CreateFeatureInput,
  scope?: WorkspaceScope,
  emitType?: string,
): Promise<FeatureRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const levels = await ctx.levelsIn(tx, ws);
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);

    const title = input.title.trim();
    if (!title) throw new FeatureError("Title is required.");
    if (!levels.some((l) => l.key === input.level))
      throw new FeatureError(`Unknown level: ${input.level}`);
    // Leaf-level items are creatable here: a spec is an attachment, not an
    // identity, so a work item with no spec is a first-class row. See ADR 0003.

    // Resolve + validate the parent (must be exactly one level up).
    let parentId: string | null = null;
    if (input.parentSpecId) {
      const parent = await tx
        .select({
          id: features.id,
          level: features.level,
          productId: features.productId,
        })
        .from(features)
        .where(
          and(
            eq(features.specId, input.parentSpecId),
            eq(features.workspaceId, ws),
          ),
        );
      if (!parent[0])
        throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
      if (!canReadProductId(access, productById, parent[0].productId)) {
        throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
      }
      if (!isValidParentLevel(input.level, parent[0].level, levels))
        throw new FeatureError(
          `A ${input.level} can't sit under a ${parent[0].level}.`,
        );
      parentId = parent[0].id;
    } else if (!isValidParentLevel(input.level, null, levels)) {
      throw new FeatureError(`A ${input.level} requires a parent.`);
    }

    // Owning product: the requested one (must belong to this workspace), else
    // the workspace's default product.
    const productId = input.productId
      ? await ctx.requireProductId(tx, ws, input.productId)
      : await ctx.defaultProductId(tx, ws);
    if (!canWriteProductId(access, productId)) {
      throw new FeatureError("Your role does not permit editing this product.");
    }
    if (input.assigneeId)
      await ctx.assertWorkspaceMember(tx, ws, input.assigneeId);

    // A release assignment must point at a release in this workspace that is
    // either a portfolio release (no product) or one scoped to the new item's
    // own product. Mirrors the rule in updateFeature.
    if (input.releaseId) {
      const release = await tx
        .select({ id: releases.id, productId: releases.productId })
        .from(releases)
        .where(
          and(eq(releases.id, input.releaseId), eq(releases.workspaceId, ws)),
        )
        .limit(1);
      if (!release[0]) {
        throw new FeatureError(`Unknown release: ${input.releaseId}`);
      }
      if (release[0].productId !== null && release[0].productId !== productId) {
        throw new FeatureError("Release belongs to a different product.");
      }
    }

    // Cycles follow the same rule on their own axis: a workspace-wide cycle
    // takes anything, a product cycle only that product's work.
    if (input.cycleId) {
      const cycle = await tx
        .select({ id: cycles.id, productId: cycles.productId })
        .from(cycles)
        .where(and(eq(cycles.id, input.cycleId), eq(cycles.workspaceId, ws)))
        .limit(1);
      if (!cycle[0]) {
        throw new FeatureError(`Unknown cycle: ${input.cycleId}`);
      }
      if (cycle[0].productId !== null && cycle[0].productId !== productId) {
        throw new FeatureError("Cycle belongs to a different product.");
      }
    }

    // An item created here has no spec attached, so it has no repo and no
    // frontmatter id; spec_id mirrors the row id, keeping every row uniformly
    // routable by specId. Attaching a spec later reuses this id (ADR 0003 D3).
    const id = randomUUID();
    const [row] = await tx
      .insert(features)
      .values({
        id,
        workspaceId: ws,
        repoId: null,
        productId,
        specId: id,
        level: input.level,
        title,
        status: input.status ?? "backlog",
        assigneeId: input.assigneeId ?? null,
        releaseId: input.releaseId ?? null,
        cycleId: input.cycleId ?? null,
        customFields: input.customFields ?? {},
        tags: input.tags ?? [],
        details: input.details?.trim() ? input.details : null,
        parentId,
        // A DB-native card's parent is user-chosen (sync never touches these
        // rows, but keep the discriminator honest). Null when it has none.
        parentSetBy: parentId ? "user" : null,
      })
      .returning();
    if (!row) throw new FeatureError("Failed to create work item.");

    // Record the creation event in the same transaction. `specId` is generated
    // here, so the store builds the payload (the caller can't know it yet).
    if (emitType) {
      await ctx.writeOutbox(tx, scope!, {
        type: emitType,
        productId: row.productId,
        data: {
          specId: row.specId,
          title: row.title,
          level: row.level,
          status: row.status,
        },
      });
    }

    return {
      specId: row.specId,
      title: row.title,
      level: row.level,
      isDbNative: true,
      productId: row.productId,
      status: row.status,
      rank: row.rank,
      tags: row.tags,
      releaseId: row.releaseId,
      cycleId: row.cycleId,
      assigneeId: row.assigneeId,
      customFields: toCustomFields(row.customFields),
      ...riceFields({
        riceReach: row.riceReach,
        riceImpact: row.riceImpact,
        riceConfidence: row.riceConfidence,
        riceEffort: row.riceEffort,
      }),
      path: "",
      blocksCount: 0,
      blockedByCount: 0,
      parentSpecId: input.parentSpecId ?? null,
      childCount: 0,
      childDoneCount: 0,
      githubSummary: emptyAgg(),
    } satisfies FeatureRecord;
  });
}

export async function deleteFeature(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
  emit?: OutboxEmit,
  opts?: DeleteFeatureOptions,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const row = await tx
      .select({
        id: features.id,
        productId: features.productId,
        specPath: specIndex.path,
      })
      .from(features)
      .leftJoin(specIndex, eq(specIndex.featureId, features.id))
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
    if (!row[0]) throw new FeatureError(`Unknown work item: ${specId}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, row[0].productId)) {
      throw new FeatureError("Your role does not permit editing this product.");
    }
    // An item with a spec attached can be deleted, but only together with its
    // git file: leaving the file behind would let the next sync re-import the
    // spec and recreate the item with default metadata, silently undoing the
    // delete. The caller removes the file first and passes `specRemoved`
    // (ADR 0003 D4). `spec_index` is ON DELETE CASCADE, so the index row goes
    // with the item either way.
    if (row[0].specPath !== null && !opts?.specRemoved) {
      throw new FeatureError(
        "This work item has a spec attached. Deleting it also deletes " +
          `${row[0].specPath} from git; pass removeSpec to confirm.`,
      );
    }
    // Children's parent_id is ON DELETE SET NULL, so they're orphaned, not deleted.
    await tx
      .delete(features)
      .where(and(eq(features.id, row[0].id), eq(features.workspaceId, ws)));
    if (emit) await ctx.writeOutbox(tx, scope!, emit);
  });
}

/**
 * See FeatureStore.pruneAutoGrouping. Every check runs inside one scoped
 * transaction, so a concurrent write cannot slip a child (or a comment, or a
 * relation) onto the grouping between the checks and the delete.
 */
export async function pruneAutoGrouping(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<boolean> {
  if (!scope) return false;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope.workspaceId;
    const [row] = await tx
      .select({
        id: features.id,
        productId: features.productId,
        repoId: features.repoId,
        externalKey: features.externalKey,
        title: features.title,
        status: features.status,
        tags: features.tags,
        customFields: features.customFields,
        releaseId: features.releaseId,
        assigneeId: features.assigneeId,
        details: features.details,
        rank: features.rank,
        riceReach: features.riceReach,
        riceImpact: features.riceImpact,
        riceConfidence: features.riceConfidence,
        riceEffort: features.riceEffort,
      })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));

    // Only a sync-created grouping is ever a candidate: a spec-backed row has
    // a repoId, and a card a person made by hand has no externalKey.
    if (!row || row.repoId !== null || row.externalKey === null) return false;
    const access = await ctx.accessIn(tx, scope);
    if (!canWriteProductId(access, row.productId)) return false;

    // Anything a person could have set means they adopted the grouping, so it
    // stops being litter and we leave it alone.
    const untouched =
      isGeneratedGroupingTitle(row.externalKey, row.title) &&
      row.status === SYNC_CREATED_STATUS &&
      row.releaseId === null &&
      row.assigneeId === null &&
      row.details === null &&
      row.rank === null &&
      row.riceReach === null &&
      row.riceImpact === null &&
      row.riceConfidence === null &&
      row.riceEffort === null &&
      (row.tags?.length ?? 0) === 0 &&
      Object.keys(row.customFields ?? {}).length === 0;
    if (!untouched) return false;

    // Referenced by anything at all: keep it. Children first, since a sibling
    // spec still living here is the common reason to stop.
    const [child] = await tx
      .select({ id: features.id })
      .from(features)
      .where(and(eq(features.parentId, row.id), eq(features.workspaceId, ws)))
      .limit(1);
    if (child) return false;

    const [relation] = await tx
      .select({ id: featureLinks.id })
      .from(featureLinks)
      .where(
        or(
          eq(featureLinks.fromFeatureId, row.id),
          eq(featureLinks.toFeatureId, row.id),
        ),
      )
      .limit(1);
    if (relation) return false;

    const [ghLink] = await tx
      .select({ id: featureGithubLinks.id })
      .from(featureGithubLinks)
      .where(eq(featureGithubLinks.featureId, row.id))
      .limit(1);
    if (ghLink) return false;

    const [comment] = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.featureId, row.id))
      .limit(1);
    if (comment) return false;

    await tx
      .delete(features)
      .where(and(eq(features.id, row.id), eq(features.workspaceId, ws)));
    return true;
  });
}

export async function updateFeature(
  ctx: DbStoreContext,
  specId: string,
  patch: FeaturePatch,
  scope?: WorkspaceScope,
  emit?: OutboxEmit,
): Promise<void> {
  // `parentSpecId` isn't a column, so translate it to the parent row's `parentId`.
  const { parentSpecId, ...rest } = patch;
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    // Reads the fields the ledger tracks, not just the one authorization
    // needs: a change's previous value is knowable only here, before the
    // update overwrites it, and no later feature can reconstruct it.
    const current = await tx
      .select({
        id: features.id,
        productId: features.productId,
        title: features.title,
        status: features.status,
        tags: features.tags,
        releaseId: features.releaseId,
        cycleId: features.cycleId,
        assigneeId: features.assigneeId,
        customFields: features.customFields,
        details: features.details,
        parentId: features.parentId,
        riceReach: features.riceReach,
        riceImpact: features.riceImpact,
        riceConfidence: features.riceConfidence,
        riceEffort: features.riceEffort,
      })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
      .limit(1);
    if (!current[0]) throw new RelationError(`Unknown feature: ${specId}`);
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    if (!canWriteProductId(access, current[0].productId)) {
      throw new RelationError(
        "Your role does not permit editing this product.",
      );
    }
    if (typeof rest.assigneeId === "string" && rest.assigneeId) {
      await ctx.assertWorkspaceMember(tx, ws, rest.assigneeId);
    }
    // A release assignment must point at a release in this workspace that is
    // either a portfolio release (no product) or one scoped to this item's
    // own product. Items can't be scheduled into another product's release.
    if (typeof rest.releaseId === "string" && rest.releaseId) {
      const release = await tx
        .select({ id: releases.id, productId: releases.productId })
        .from(releases)
        .where(
          and(eq(releases.id, rest.releaseId), eq(releases.workspaceId, ws)),
        )
        .limit(1);
      if (!release[0]) {
        throw new RelationError(`Unknown release: ${rest.releaseId}`);
      }
      if (
        release[0].productId !== null &&
        release[0].productId !== current[0].productId
      ) {
        throw new RelationError("Release belongs to a different product.");
      }
    }
    // Same rule for the cycle axis; the two are independent, so setting one
    // never validates or clears the other.
    if (typeof rest.cycleId === "string" && rest.cycleId) {
      const cycle = await tx
        .select({ id: cycles.id, productId: cycles.productId })
        .from(cycles)
        .where(and(eq(cycles.id, rest.cycleId), eq(cycles.workspaceId, ws)))
        .limit(1);
      if (!cycle[0]) {
        throw new RelationError(`Unknown cycle: ${rest.cycleId}`);
      }
      if (
        cycle[0].productId !== null &&
        cycle[0].productId !== current[0].productId
      ) {
        throw new RelationError("Cycle belongs to a different product.");
      }
    }
    const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (parentSpecId !== undefined) {
      // Record that a person set this parent, so a later `feature:` frontmatter
      // change on re-sync leaves it alone (gh-51). Covers detaching to the
      // Unassigned view too: an unparented item stays unassigned.
      set.parentSetBy = "user";
      if (parentSpecId === null) {
        set.parentId = null;
      } else {
        const parent = await tx
          .select({ id: features.id, productId: features.productId })
          .from(features)
          .where(
            and(
              eq(features.specId, parentSpecId),
              eq(features.workspaceId, scope!.workspaceId),
            ),
          );
        if (!parent[0])
          throw new RelationError(`Unknown parent feature: ${parentSpecId}`);
        if (!canReadProductId(access, productById, parent[0].productId)) {
          throw new RelationError(`Unknown parent feature: ${parentSpecId}`);
        }
        set.parentId = parent[0].id;
      }
    }
    // Computed before the update, against the values it is about to replace.
    const changes = ledgerChanges(current[0], set);
    await tx
      .update(features)
      .set(set)
      .where(
        and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope!.workspaceId),
        ),
      );
    // The title recorded on the row is the one the item had when it changed,
    // including on the write that renames it, so the history reads as what
    // the item was called at the time rather than what it is called now.
    await writeItemEvents(
      ctx,
      tx,
      scope!,
      {
        featureId: current[0].id,
        specId,
        title: current[0].title,
        productId: current[0].productId,
      },
      changes,
    );
    if (emit) await ctx.writeOutbox(tx, scope!, emit);
  });
}

export async function addRelation(
  ctx: DbStoreContext,
  specId: string,
  input: RelationInput,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const ids = await tx
      .select({
        id: features.id,
        specId: features.specId,
        productId: features.productId,
      })
      .from(features)
      .where(
        and(
          eq(features.workspaceId, ws),
          inArray(features.specId, [specId, input.toSpecId]),
        ),
      );
    const self = ids.find((f) => f.specId === specId);
    const other = ids.find((f) => f.specId === input.toSpecId);
    if (!self) throw new RelationError(`Unknown feature: ${specId}`);
    if (!other)
      throw new RelationError(`Unknown related feature: ${input.toSpecId}`);
    if (self.id === other.id)
      throw new RelationError("A feature cannot relate to itself.");
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    if (!canWriteProductId(access, self.productId)) {
      throw new RelationError(
        "Your role does not permit editing this product.",
      );
    }
    if (!canReadProductId(access, productById, other.productId)) {
      throw new RelationError(`Unknown related feature: ${input.toSpecId}`);
    }

    // Resolve the requested direction into a canonical stored edge.
    const edge = toEdge(self.id, other.id, input.direction);

    // Reject a contradictory cycle (A blocks B while B blocks A).
    if (edge.type === "blocks") {
      const reverse = await tx
        .select({ id: featureLinks.id })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, ws),
            eq(featureLinks.type, "blocks"),
            eq(featureLinks.fromFeatureId, edge.toFeatureId),
            eq(featureLinks.toFeatureId, edge.fromFeatureId),
          ),
        );
      if (reverse.length)
        throw new RelationError(
          "That would create a circular blocking dependency.",
        );
    }

    // Treat `relates_to` as symmetric: skip if the inverse edge exists.
    if (edge.type === "relates_to") {
      const existing = await tx
        .select({ id: featureLinks.id })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, ws),
            eq(featureLinks.type, "relates_to"),
            eq(featureLinks.fromFeatureId, edge.toFeatureId),
            eq(featureLinks.toFeatureId, edge.fromFeatureId),
          ),
        );
      if (existing.length) return;
    }

    await tx
      .insert(featureLinks)
      .values({ workspaceId: ws, ...edge })
      .onConflictDoNothing();
  });
}

export async function removeRelation(
  ctx: DbStoreContext,
  specId: string,
  linkId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const link = await tx.query.featureLinks.findFirst({
      where: and(eq(featureLinks.id, linkId), eq(featureLinks.workspaceId, ws)),
    });
    if (!link) return;
    const endpoints = await tx
      .select({
        id: features.id,
        specId: features.specId,
        productId: features.productId,
      })
      .from(features)
      .where(
        and(
          eq(features.workspaceId, ws),
          inArray(features.id, [link.fromFeatureId, link.toFeatureId]),
        ),
      );
    const self = endpoints.find((feature) => feature.specId === specId);
    if (!self) throw new RelationError(`Unknown relation: ${linkId}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, self.productId)) {
      throw new RelationError(
        "Your role does not permit editing this product.",
      );
    }
    await tx
      .delete(featureLinks)
      .where(
        and(
          eq(featureLinks.id, linkId),
          eq(featureLinks.workspaceId, scope!.workspaceId),
        ),
      );
  });
}

export async function addGithubLink(
  ctx: DbStoreContext,
  specId: string,
  link: ResolvedGithubLink,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const feat = await tx
      .select({ id: features.id, productId: features.productId })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
    if (!feat[0]) throw new RelationError(`Unknown feature: ${specId}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, feat[0].productId)) {
      throw new RelationError(
        "Your role does not permit editing this product.",
      );
    }
    const repo = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.id, link.repoId), eq(repositories.workspaceId, ws)),
      )
      .limit(1);
    if (!repo[0])
      throw new RelationError("Unknown repository for GitHub link.");
    await tx
      .insert(featureGithubLinks)
      .values({
        workspaceId: ws,
        featureId: feat[0].id,
        repoId: link.repoId,
        kind: link.kind,
        number: link.number,
        branch: link.branch,
        url: link.url,
        title: link.title,
        state: link.state,
        headBranch: link.headBranch ?? null,
        authorId: link.authorId ?? null,
      })
      // Re-linking the same url refreshes the cached title/state.
      .onConflictDoUpdate({
        target: [featureGithubLinks.featureId, featureGithubLinks.url],
        set: {
          title: link.title,
          state: link.state,
          // Only ever set, never cleared. Someone hand-linking the url of a
          // pull request the write path opened would otherwise demote a
          // pending change to an ordinary link, and the author would be told
          // their change is no longer waiting for review when it still is.
          ...(link.headBranch ? { headBranch: link.headBranch } : {}),
          // Same rule for the author: a second edit joining an open proposal
          // must not reassign whose change it is to whoever touched it last.
          ...(link.authorId ? { authorId: link.authorId } : {}),
        },
      });
  });
}

/**
 * One item's change history, newest first.
 *
 * Joins through `features` rather than trusting the caller's spec id against
 * the snapshotted `spec_id` column: the ledger keeps history for deleted
 * items, and matching on the snapshot alone would let a caller read the
 * history of an item they can no longer see.
 */
export async function listItemEvents(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
  limit = 100,
): Promise<ItemEvent[]> {
  if (!scope) return [];
  return ctx.scoped(scope, async (tx) => {
    const ws = scope.workspaceId;
    const feature = await tx
      .select({ id: features.id, productId: features.productId })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
      .limit(1);
    if (!feature[0]) return [];
    const access = await ctx.accessIn(tx, scope);
    const productById = await ctx.productVisibilityIn(tx, ws);
    if (!canReadProductId(access, productById, feature[0].productId)) return [];

    const rows = await tx
      .select({
        id: itemEvents.id,
        type: itemEvents.type,
        field: itemEvents.field,
        before: itemEvents.before,
        after: itemEvents.after,
        actorType: itemEvents.actorType,
        actorId: itemEvents.actorId,
        actorLabel: itemEvents.actorLabel,
        createdAt: itemEvents.createdAt,
      })
      .from(itemEvents)
      .where(
        and(
          eq(itemEvents.workspaceId, ws),
          eq(itemEvents.featureId, feature[0].id),
        ),
      )
      .orderBy(desc(itemEvents.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      ...r,
      actorType: r.actorType as ActorType,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

/**
 * Cross-item activity report over the change ledger.
 *
 * Aggregated in Postgres rather than by reading rows into memory: this is the
 * one caller whose result set grows without bound as a workspace is used, and
 * a report that works for a month and dies at a year is not a report.
 *
 * Product visibility is applied by joining `features`, so a private product's
 * changes never reach someone who cannot see the items. That also means an
 * event whose item has since been deleted is not counted here, which is the
 * right trade for a report: the row is kept for audit, but there is no item
 * left to check anyone's access against.
 */
export async function itemActivitySummary(
  ctx: DbStoreContext,
  query: ActivityQuery,
  scope?: WorkspaceScope,
): Promise<ActivitySummary> {
  const empty: ActivitySummary = {
    since: null,
    total: 0,
    byActor: [],
    byField: [],
    byDay: [],
    stageTime: [],
  };
  if (!scope) return empty;

  return ctx.scoped(scope, async (tx) => {
    const ws = scope.workspaceId;
    const access = await ctx.accessIn(tx, scope);
    const productById = await ctx.productVisibilityIn(tx, ws);
    const readable = [...productById.values()]
      .filter((p) => canReadProduct(access, p))
      .map((p) => p.id);
    // Intersected with what the caller can read, never substituted for it:
    // asking for a product you cannot see must narrow the report, not widen
    // it.
    // An empty list is a request for nothing, not a request for everything:
    // a product group with no products must report zero rather than inherit
    // the workspace's numbers.
    const requested = query.productIds;
    const scoped =
      requested != null
        ? readable.filter((id) => requested.includes(id))
        : readable;

    // Each id is bound as a parameter rather than pasted into the string.
    // They are database-issued uuids today, so interpolation would be safe
    // and would still be a template waiting to be copied somewhere it is not.
    // An empty list is handled separately: `in ()` is a syntax error.
    const productFilter =
      scoped.length > 0
        ? sql`and (e.product_id is null or e.product_id in (${sql.join(
            scoped.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}))`
        : sql`and e.product_id is null`;

    const window = sql`
      e.workspace_id = ${ws}
      and e.created_at >= ${query.from}
      and e.created_at < ${query.to}
      ${productFilter}
    `;

    const [sinceRow] = (await tx.execute(sql`
      select min(created_at) as since from item_events where workspace_id = ${ws}
    `)) as unknown as { since: Date | string | null }[];

    const byActor = (await tx.execute(sql`
      select e.actor_type, e.actor_id, e.actor_label, count(*)::int as count
      from item_events e
      where ${window}
      group by e.actor_type, e.actor_id, e.actor_label
      order by count desc
      limit 50
    `)) as unknown as {
      actor_type: string;
      actor_id: string | null;
      actor_label: string | null;
      count: number;
    }[];

    const byField = (await tx.execute(sql`
      select e.type, e.field, count(*)::int as count
      from item_events e
      where ${window}
      group by e.type, e.field
      order by count desc
    `)) as unknown as { type: string; field: string | null; count: number }[];

    const byDay = (await tx.execute(sql`
      select to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') as day,
             count(*)::int as count
      from item_events e
      where ${window}
      group by day
      order by day
    `)) as unknown as { day: string; count: number }[];

    // Time in a stage is the gap between two consecutive status changes on
    // the same item, so the span belongs to the status being left. The first
    // recorded change for an item has no predecessor and is skipped: we do
    // not know when it entered that stage, and assuming the item's creation
    // date would invent data for anything that existed before the ledger did.
    const stageTime = (await tx.execute(sql`
      with spans as (
        select e.before #>> '{}' as status,
               e.created_at - lag(e.created_at) over (
                 partition by e.feature_id order by e.created_at
               ) as elapsed
        from item_events e
        where ${window} and e.field = 'status'
      )
      select status,
             round(avg(extract(epoch from elapsed)) / 3600.0, 2)::float8 as average_hours,
             count(*)::int as samples
      from spans
      where elapsed is not null and status is not null
      group by status
      order by samples desc
    `)) as unknown as {
      status: string;
      average_hours: number;
      samples: number;
    }[];

    const since = sinceRow?.since ?? null;
    return {
      since: since ? new Date(since).toISOString() : null,
      total: byField.reduce((sum, r) => sum + Number(r.count), 0),
      byActor: byActor.map((r) => ({
        actorType: r.actor_type as ActorType,
        actorId: r.actor_id,
        actorLabel: r.actor_label,
        count: Number(r.count),
      })),
      byField: byField.map((r) => ({
        type: r.type,
        field: r.field,
        count: Number(r.count),
      })),
      byDay: byDay.map((r) => ({ day: r.day, count: Number(r.count) })),
      stageTime: stageTime.map((r) => ({
        status: r.status,
        averageHours: Number(r.average_hours),
        samples: Number(r.samples),
      })),
    };
  });
}

export async function removeGithubLink(
  ctx: DbStoreContext,
  specId: string,
  linkId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const rows = await tx
      .select({
        featureId: featureGithubLinks.featureId,
        specId: features.specId,
        productId: features.productId,
      })
      .from(featureGithubLinks)
      .innerJoin(features, eq(features.id, featureGithubLinks.featureId))
      .where(
        and(
          eq(featureGithubLinks.id, linkId),
          eq(featureGithubLinks.workspaceId, ws),
          eq(features.workspaceId, ws),
        ),
      )
      .limit(1);
    if (!rows[0]) return;
    if (rows[0].specId !== specId) {
      throw new RelationError(`Unknown GitHub link: ${linkId}`);
    }
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, rows[0].productId)) {
      throw new RelationError(
        "Your role does not permit editing this product.",
      );
    }
    await tx
      .delete(featureGithubLinks)
      .where(
        and(
          eq(featureGithubLinks.id, linkId),
          eq(featureGithubLinks.workspaceId, scope!.workspaceId),
        ),
      );
  });
}

/**
 * Append change-ledger rows, in the same transaction as the change itself so
 * a change can never exist without its record.
 *
 * One row per field, not one per request: a patch that moves an item's status
 * and reassigns it is two changes, and reverting or reporting on either one
 * separately is the whole point. A request that changes nothing writes
 * nothing, so re-saving a form does not pad the history.
 */
async function writeItemEvents(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  subject: ItemEventSubject,
  changes: ItemFieldChange[],
): Promise<void> {
  if (changes.length === 0) return;
  // An unstated actor is a person in the browser. Every other caller is
  // expected to say what it is; see WorkspaceScope.actor.
  const actor = scope.actor ?? { type: "user", id: scope.userId, label: null };
  await tx.insert(itemEvents).values(
    changes.map((c) => ({
      workspaceId: scope.workspaceId,
      featureId: subject.featureId,
      specId: subject.specId,
      itemTitle: subject.title,
      productId: subject.productId,
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      type: c.type ?? "item.field_changed",
      field: c.field,
      // jsonb, so `null` and "absent" are different things: null means the
      // field was genuinely cleared, which revert has to be able to reproduce.
      before: c.before ?? null,
      after: c.after ?? null,
    })),
  );
}
