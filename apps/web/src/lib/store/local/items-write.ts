/**
 * Items: the write side, plus relations and GitHub links, in local file mode.
 *
 * A write here is read-modify-write over a JSON file rather than an UPDATE, and
 * there is no transaction. A method that touches both the items file and the
 * metadata map therefore writes two files with no guarantee that both land,
 * which is a real difference from the Postgres store and one of the reasons
 * local mode is for a repository someone is working in rather than for a team.
 *
 * The change ledger the Postgres store keeps has no counterpart. `listItemEvents`
 * and `itemActivitySummary` return nothing, because local mode records no
 * history: the repository's own git log is the history, and duplicating it into
 * a JSON file would be a second, worse answer to a question git already answers.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isValidParentLevel, resolveLevels } from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import {
  type ActivityQuery,
  type ActivitySummary,
  type CreateFeatureInput,
  type DeleteFeatureOptions,
  FeatureError,
  type FeaturePatch,
  type FeatureRecord,
  type ItemEvent,
  type OutboxEmit,
  RelationError,
  type RelationInput,
  type ResolvedGithubLink,
  type WorkspaceScope,
} from "../types";

import { emptyGithubSummary, type LocalStoreContext } from "./context";
import { readCycles } from "./cycles";
import { readReleases } from "./releases";
import { type LocalItem, toLocalEdge } from "./types";

export async function createFeature(
  ctx: LocalStoreContext,
  input: CreateFeatureInput,
  _scope?: WorkspaceScope,
  _emitType?: string, // webhooks are DB-only; ignored in local file mode
): Promise<FeatureRecord> {
  const levels = resolveLevels();
  const title = input.title.trim();
  if (!title) throw new FeatureError("Title is required.");
  if (!levels.some((l) => l.key === input.level))
    throw new FeatureError(`Unknown level: ${input.level}`);
  // Leaf-level items are creatable here too: a spec is an attachment, not an
  // identity, so a work item with no spec is a first-class row (ADR 0003).

  if (input.parentSpecId) {
    const all = await ctx.loadAll();
    const parent = all.find((f) => f.specId === input.parentSpecId);
    if (!parent)
      throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
    if (!isValidParentLevel(input.level, parent.level, levels))
      throw new FeatureError(
        `A ${input.level} can't sit under a ${parent.level}.`,
      );
  } else if (!isValidParentLevel(input.level, null, levels)) {
    throw new FeatureError(`A ${input.level} requires a parent.`);
  }

  const id = randomUUID();
  const productId = input.productId ?? (await ctx.defaultProductId());
  // Mirror the DB store: a release must exist and be a portfolio release or
  // one scoped to this item's product.
  if (input.releaseId) {
    const release = (await readReleases(ctx)).find(
      (r) => r.id === input.releaseId,
    );
    if (!release) {
      throw new FeatureError(`Unknown release: ${input.releaseId}`);
    }
    const releaseProductId = release.productId ?? null;
    if (releaseProductId !== null && releaseProductId !== productId) {
      throw new FeatureError("Release belongs to a different product.");
    }
  }
  // Cycles follow the same rule on their own axis.
  if (input.cycleId) {
    const cycle = (await readCycles(ctx)).find((c) => c.id === input.cycleId);
    if (!cycle) throw new FeatureError(`Unknown cycle: ${input.cycleId}`);
    const cycleProductId = cycle.productId ?? null;
    if (cycleProductId !== null && cycleProductId !== productId) {
      throw new FeatureError("Cycle belongs to a different product.");
    }
  }
  const item: LocalItem = {
    id,
    title,
    level: input.level,
    status: input.status ?? "backlog",
    assigneeId: input.assigneeId ?? null,
    tags: input.tags ?? [],
    parentSpecId: input.parentSpecId ?? null,
    releaseId: input.releaseId ?? null,
    cycleId: input.cycleId ?? null,
    productId,
    details: input.details?.trim() ? input.details : null,
    customFields: input.customFields ?? {},
  };
  const items = await ctx.readItems();
  await ctx.writeItems([...items, item]);

  return {
    specId: id,
    title,
    level: item.level,
    isDbNative: true,
    productId,
    status: item.status,
    rank: null,
    tags: item.tags,
    releaseId: item.releaseId ?? null,
    cycleId: item.cycleId ?? null,
    assigneeId: item.assigneeId,
    customFields: item.customFields ?? {},
    ...riceFields({
      riceReach: null,
      riceImpact: null,
      riceConfidence: null,
      riceEffort: null,
    }),
    path: "",
    blocksCount: 0,
    blockedByCount: 0,
    parentSpecId: item.parentSpecId,
    childCount: 0,
    childDoneCount: 0,
    githubSummary: emptyGithubSummary(),
  } satisfies FeatureRecord;
}

export async function deleteFeature(
  ctx: LocalStoreContext,
  specId: string,
  _scope?: WorkspaceScope,
  _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
  opts?: DeleteFeatureOptions,
): Promise<void> {
  const items = await ctx.readItems();
  if (items.some((i) => i.id === specId)) {
    // No spec attached: an ordinary delete of the tracking record.
    await ctx.writeItems(items.filter((i) => i.id !== specId));
    return;
  }
  // Otherwise it's a spec file. Deleting the record without the file would
  // just re-read it on the next load, so the file goes too (ADR 0003 D4).
  // This store owns the working tree, so it performs the removal itself
  // rather than relying on a caller's prior git delete.
  const all = await ctx.loadAll();
  const feature = all.find((f) => f.specId === specId);
  if (!feature) throw new FeatureError(`Unknown work item: ${specId}`);
  if (!opts?.specRemoved) {
    throw new FeatureError(
      "This work item has a spec attached. Deleting it also deletes " +
        `${feature.path}; pass removeSpec to confirm.`,
    );
  }
  await fs.rm(path.join(ctx.root, feature.path), { force: true });
  // Drop the item's sidecar metadata so a same-id spec restored later starts
  // clean rather than inheriting a deleted item's status.
  const meta = await ctx.readMetadata();
  delete meta[specId];
  await ctx.writeMetadata(meta);
}

/**
 * No-op in local file mode. Auto-created Feature groupings only ever come
 * from GitHub sync, which is DB-only, so this store can never hold one.
 */
export async function pruneAutoGrouping(
  _specId: string,
  _scope?: WorkspaceScope,
): Promise<boolean> {
  return false;
}

export async function updateFeature(
  ctx: LocalStoreContext,
  specId: string,
  patch: FeaturePatch,
  _scope?: WorkspaceScope,
  _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
): Promise<void> {
  // DB-native items live in their own file, not the spec-metadata map.
  const items = await ctx.readItems();
  const idx = items.findIndex((i) => i.id === specId);
  if (idx >= 0) {
    const it = items[idx]!;
    if (patch.title !== undefined) it.title = patch.title;
    if (patch.status !== undefined) it.status = patch.status;
    if (patch.tags !== undefined) it.tags = patch.tags;
    if (patch.releaseId !== undefined) it.releaseId = patch.releaseId;
    if (patch.assigneeId !== undefined) it.assigneeId = patch.assigneeId;
    if (patch.parentSpecId !== undefined) it.parentSpecId = patch.parentSpecId;
    if (patch.details !== undefined)
      it.details = patch.details?.trim() ? patch.details : null;
    if (patch.riceReach !== undefined) it.riceReach = patch.riceReach;
    if (patch.riceImpact !== undefined) it.riceImpact = patch.riceImpact;
    if (patch.riceConfidence !== undefined)
      it.riceConfidence = patch.riceConfidence;
    if (patch.riceEffort !== undefined) it.riceEffort = patch.riceEffort;
    await ctx.writeItems(items);
    return;
  }
  const meta = await ctx.readMetadata();
  meta[specId] = { ...meta[specId], ...patch };
  await ctx.writeMetadata(meta);
}

export async function addRelation(
  ctx: LocalStoreContext,
  specId: string,
  input: RelationInput,
  _scope?: WorkspaceScope,
): Promise<void> {
  if (specId === input.toSpecId)
    throw new RelationError("A feature cannot relate to itself.");
  const all = await ctx.loadAll();
  const known = new Set(all.map((f) => f.specId));
  if (!known.has(specId)) throw new RelationError(`Unknown feature: ${specId}`);
  if (!known.has(input.toSpecId))
    throw new RelationError(`Unknown related feature: ${input.toSpecId}`);

  const { from, link } = toLocalEdge(specId, input.toSpecId, input.direction);
  const meta = await ctx.readMetadata();

  // Reject a contradictory cycle (A blocks B while B blocks A).
  if (link.type === "blocks") {
    const reverse = (meta[link.to]?.links ?? []).some(
      (l) => l.type === "blocks" && l.to === from,
    );
    if (reverse)
      throw new RelationError(
        "That would create a circular blocking dependency.",
      );
  }

  const existing = meta[from]?.links ?? [];
  // Symmetric relates_to: skip if the inverse edge already exists.
  const inverseExists =
    link.type === "relates_to" &&
    (meta[link.to]?.links ?? []).some(
      (l) => l.type === "relates_to" && l.to === from,
    );
  const duplicate = existing.some(
    (l) => l.to === link.to && l.type === link.type,
  );
  if (!duplicate && !inverseExists) {
    meta[from] = { ...meta[from], links: [...existing, link] };
    await ctx.writeMetadata(meta);
  }
}

export async function removeRelation(
  ctx: LocalStoreContext,
  _specId: string,
  linkId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  // linkId is `${fromSpec}:${toSpec}:${type}` (see localLinkId).
  const [fromSpec, toSpec, type] = linkId.split(":");
  if (!fromSpec || !toSpec || !type) return;
  const meta = await ctx.readMetadata();
  const links = meta[fromSpec]?.links;
  if (!links) return;
  meta[fromSpec] = {
    ...meta[fromSpec],
    links: links.filter((l) => !(l.to === toSpec && l.type === type)),
  };
  await ctx.writeMetadata(meta);
}

// GitHub linking requires a connected GitHub App, which file mode doesn't
// have. Reads return nothing (see loadAll); writes are rejected clearly.
export async function addGithubLink(
  _specId: string,
  _link: ResolvedGithubLink,
  _scope?: WorkspaceScope,
): Promise<void> {
  throw new RelationError(
    "GitHub linking requires a connected repository (not available in local file mode).",
  );
}

export async function removeGithubLink(
  _specId: string,
  _linkId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  // Nothing to remove in file mode.
}

/**
 * File mode keeps no change ledger. There is one implicit user and no
 * database to append to, and the specs themselves are files in a git working
 * tree, so their history is already the user's own `git log`.
 */
export async function listItemEvents(
  _specId: string,
  _scope?: WorkspaceScope,
  _limit?: number,
): Promise<ItemEvent[]> {
  return [];
}

/** Nothing is recorded in file mode, so there is nothing to report on. */
export async function itemActivitySummary(
  _query: ActivityQuery,
  _scope?: WorkspaceScope,
): Promise<ActivitySummary> {
  return {
    since: null,
    total: 0,
    byActor: [],
    byField: [],
    byDay: [],
    stageTime: [],
  };
}
