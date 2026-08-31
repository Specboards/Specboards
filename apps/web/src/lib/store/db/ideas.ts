/**
 * Ideas: the intake queue, and the stages an idea moves through before it is
 * either promoted into the backlog or dropped.
 *
 * The one domain that writes into another's table. `promoteIdea` creates a
 * real work item from an idea in the same transaction that stamps the idea as
 * promoted, so the two can never disagree about whether promotion happened.
 * It is also why this module reaches for `levelsIn` and `defaultProductId`:
 * the item it creates has to land at a real level, in a real product, exactly
 * as one created through the items API would.
 *
 * Reads filter by product visibility rather than refusing, so an idea against
 * a product the caller cannot see is simply not in the list.
 *
 * The idea settings live here rather than with the workspace settings. Step 2
 * put them on `WorkspaceSettingsStore` because it re-wrapped only contiguous
 * declarations, and the card flagged that as worth revisiting when the
 * implementations moved. They are idea configuration, so they moved with the
 * ideas.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";

import { promotedIdeaStatus, resolveIdeaStages } from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import {
  and,
  asc,
  count,
  eq,
  features,
  ideaSettings,
  ideaStatuses,
  ideaVotes,
  ideas,
  inArray,
  users,
} from "@specboards/db";

import {
  IdeaError,
  type FeatureRecord,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type IdeaStage,
  type StatusStageInput,
  type WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  canWriteProductId,
  emptyAgg,
  toCustomFields,
  type DbStoreContext,
  type Tx,
} from "./context";
export async function listIdeas(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<IdeaRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, access, productById] = await Promise.all([
      tx.query.ideas.findMany({ where: eq(ideas.workspaceId, ws) }),
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    const visible = rows.filter((r) =>
      canReadProductId(access, productById, r.productId),
    );
    if (visible.length === 0) return [];

    const [voteRows, myVotes, authorRows, promotedRows] = await Promise.all([
      tx
        .select({ ideaId: ideaVotes.ideaId, n: count() })
        .from(ideaVotes)
        .where(eq(ideaVotes.workspaceId, ws))
        .groupBy(ideaVotes.ideaId),
      tx
        .select({ ideaId: ideaVotes.ideaId })
        .from(ideaVotes)
        .where(
          and(
            eq(ideaVotes.workspaceId, ws),
            eq(ideaVotes.userId, scope!.userId),
          ),
        ),
      (() => {
        const authorIds = [
          ...new Set(visible.map((r) => r.authorId).filter(Boolean)),
        ] as string[];
        return authorIds.length
          ? tx
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, authorIds))
          : Promise.resolve([] as { id: string; name: string }[]);
      })(),
      (() => {
        const featureIds = [
          ...new Set(visible.map((r) => r.promotedFeatureId).filter(Boolean)),
        ] as string[];
        return featureIds.length
          ? tx
              .select({
                id: features.id,
                specId: features.specId,
                title: features.title,
              })
              .from(features)
              .where(inArray(features.id, featureIds))
          : Promise.resolve(
              [] as { id: string; specId: string; title: string }[],
            );
      })(),
    ]);

    const countById = new Map(
      voteRows.map((v) => [v.ideaId, Number(v.n)] as const),
    );
    const votedIds = new Set(myVotes.map((v) => v.ideaId));
    const authorById = new Map(authorRows.map((a) => [a.id, a.name] as const));
    const promotedById = new Map(promotedRows.map((f) => [f.id, f] as const));

    return visible
      .map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        productId: r.productId,
        authorName: r.authorId ? (authorById.get(r.authorId) ?? null) : null,
        submitterName: r.submitterName,
        voteCount: countById.get(r.id) ?? 0,
        viewerHasVoted: votedIds.has(r.id),
        promotedFeatureSpecId: r.promotedFeatureId
          ? (promotedById.get(r.promotedFeatureId)?.specId ?? null)
          : null,
        promotedFeatureTitle: r.promotedFeatureId
          ? (promotedById.get(r.promotedFeatureId)?.title ?? null)
          : null,
        createdAt: r.createdAt.toISOString(),
      }))
      .sort(
        (a, b) =>
          b.voteCount - a.voteCount ||
          (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
      );
  });
}

export async function createIdea(
  ctx: DbStoreContext,
  input: IdeaInput,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const title = input.title.trim();
    if (!title) throw new IdeaError("Idea title is required.");
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    const productId = input.productId
      ? await ctx.requireProductId(tx, ws, input.productId)
      : await ctx.defaultProductId(tx, ws);
    // Capturing an idea for a product requires being able to see that backlog.
    if (!canReadProductId(access, productById, productId)) {
      throw new IdeaError("Unknown product.");
    }
    const [row] = await tx
      .insert(ideas)
      .values({
        workspaceId: ws,
        productId,
        title,
        description: input.description?.trim()
          ? input.description.trim()
          : null,
        status: "new",
        authorId: scope!.userId,
      })
      .returning({ id: ideas.id });
    if (!row) throw new IdeaError("Failed to create idea.");
    const idea = await hydrateIdea(ctx, tx, scope!, row.id);
    if (!idea) throw new IdeaError("Failed to load the new idea.");
    return idea;
  });
}

export async function updateIdea(
  ctx: DbStoreContext,
  id: string,
  patch: IdeaPatch,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx.query.ideas.findFirst({
      where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
    });
    if (!current) throw new IdeaError(`Unknown idea: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    // Editing an idea (status, retitle, reassign) requires write on its product.
    if (!canWriteProductId(access, current.productId)) {
      throw new IdeaError("Your role does not permit editing this idea.");
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new IdeaError("Idea title is required.");
      set.title = title;
    }
    if (patch.description !== undefined) {
      set.description = patch.description?.trim()
        ? patch.description.trim()
        : null;
    }
    if (patch.status !== undefined) {
      const stages = await ideaStagesIn(ctx, tx, ws);
      if (!stages.some((s) => s.key === patch.status)) {
        throw new IdeaError(`Unknown idea status: ${patch.status}`);
      }
      set.status = patch.status;
    }
    if (patch.productId !== undefined) {
      const productId = patch.productId
        ? await ctx.requireProductId(tx, ws, patch.productId)
        : await ctx.defaultProductId(tx, ws);
      if (!canWriteProductId(access, productId)) {
        throw new IdeaError("Your role does not permit that product.");
      }
      set.productId = productId;
    }
    await tx
      .update(ideas)
      .set(set)
      .where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));
    const idea = await hydrateIdea(ctx, tx, scope!, id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    return idea;
  });
}

export async function deleteIdea(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx.query.ideas.findFirst({
      where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
      columns: { productId: true },
    });
    if (!current) throw new IdeaError(`Unknown idea: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current.productId)) {
      throw new IdeaError("Your role does not permit deleting this idea.");
    }
    // idea_votes cascade on the FK.
    await tx
      .delete(ideas)
      .where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));
  });
}

export async function voteIdea(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const idea = await hydrateIdea(ctx, tx, scope!, id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    // Idempotent: the unique (idea, user) index makes a repeat vote a no-op.
    await tx
      .insert(ideaVotes)
      .values({ workspaceId: ws, ideaId: id, userId: scope!.userId })
      .onConflictDoNothing({
        target: [ideaVotes.ideaId, ideaVotes.userId],
      });
    const updated = await hydrateIdea(ctx, tx, scope!, id);
    if (!updated) throw new IdeaError(`Unknown idea: ${id}`);
    return updated;
  });
}

export async function unvoteIdea(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const idea = await hydrateIdea(ctx, tx, scope!, id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    await tx
      .delete(ideaVotes)
      .where(
        and(
          eq(ideaVotes.workspaceId, ws),
          eq(ideaVotes.ideaId, id),
          eq(ideaVotes.userId, scope!.userId),
        ),
      );
    const updated = await hydrateIdea(ctx, tx, scope!, id);
    if (!updated) throw new IdeaError(`Unknown idea: ${id}`);
    return updated;
  });
}

export async function promoteIdea(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx.query.ideas.findFirst({
      where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
    });
    if (!current) throw new IdeaError(`Unknown idea: ${id}`);
    if (current.promotedFeatureId) {
      throw new IdeaError("This idea has already been promoted.");
    }
    const access = await ctx.accessIn(tx, scope!);
    const productId = current.productId ?? (await ctx.defaultProductId(tx, ws));
    if (!canWriteProductId(access, productId)) {
      throw new IdeaError("Your role does not permit promoting this idea.");
    }
    // Promote into the deepest non-leaf (planning) level; leaf items come from
    // specs, so a hierarchy with only a leaf can't accept a promotion.
    const levels = await ctx.levelsIn(tx, ws);
    const target = [...levels].reverse().find((l) => !l.isLeaf);
    if (!target) {
      throw new IdeaError(
        "This workspace has no non-leaf level to promote an idea into.",
      );
    }
    const featureId = randomUUID();
    const [featureRow] = await tx
      .insert(features)
      .values({
        id: featureId,
        workspaceId: ws,
        repoId: null,
        productId,
        specId: featureId,
        level: target.key,
        title: current.title,
        status: "backlog",
        details: current.description?.trim() ? current.description : null,
        parentId: null,
      })
      .returning();
    if (!featureRow) throw new IdeaError("Failed to create the feature.");

    const stages = await ideaStagesIn(ctx, tx, ws);
    await tx
      .update(ideas)
      .set({
        promotedFeatureId: featureId,
        status: promotedIdeaStatus(current.status, stages),
        updatedAt: new Date(),
      })
      .where(and(eq(ideas.id, id), eq(ideas.workspaceId, ws)));

    const idea = await hydrateIdea(ctx, tx, scope!, id);
    if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
    const feature: FeatureRecord = {
      specId: featureRow.specId,
      title: featureRow.title,
      level: featureRow.level,
      isDbNative: true,
      productId: featureRow.productId,
      status: featureRow.status,
      rank: featureRow.rank,
      tags: featureRow.tags,
      releaseId: featureRow.releaseId,
      cycleId: featureRow.cycleId,
      assigneeId: featureRow.assigneeId,
      customFields: toCustomFields(featureRow.customFields),
      ...riceFields({
        riceReach: featureRow.riceReach,
        riceImpact: featureRow.riceImpact,
        riceConfidence: featureRow.riceConfidence,
        riceEffort: featureRow.riceEffort,
      }),
      path: "",
      blocksCount: 0,
      blockedByCount: 0,
      parentSpecId: null,
      childCount: 0,
      childDoneCount: 0,
      githubSummary: emptyAgg(),
    };
    return { idea, feature };
  });
}

export async function listIdeaStatuses(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  return ctx.scoped(scope, async (tx) => {
    const rows = await tx
      .select()
      .from(ideaStatuses)
      .where(eq(ideaStatuses.workspaceId, scope!.workspaceId))
      .orderBy(asc(ideaStatuses.position));
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      position: r.position,
    }));
  });
}

export async function replaceIdeaStatuses(
  ctx: DbStoreContext,
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const keys = stages.map((s) => s.key);
    const fallback = keys[0]!;
    const validKeys = new Set(keys);
    // Re-home any idea whose status is no longer a stage.
    const used = await tx
      .selectDistinct({ status: ideas.status })
      .from(ideas)
      .where(eq(ideas.workspaceId, ws));
    const orphaned = used.map((u) => u.status).filter((s) => !validKeys.has(s));
    if (orphaned.length > 0) {
      await tx
        .update(ideas)
        .set({ status: fallback, updatedAt: new Date() })
        .where(and(eq(ideas.workspaceId, ws), inArray(ideas.status, orphaned)));
    }
    await tx.delete(ideaStatuses).where(eq(ideaStatuses.workspaceId, ws));
    if (stages.length > 0) {
      await tx.insert(ideaStatuses).values(
        stages.map((s, i) => ({
          workspaceId: ws,
          key: s.key,
          label: s.label,
          position: i,
        })),
      );
    }
    return stages.map((s, i) => ({
      key: s.key,
      label: s.label,
      position: i,
    }));
  });
}

export async function getIdeaSettings(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  return ctx.scoped(scope, async (tx) => {
    const row = await tx.query.ideaSettings.findFirst({
      where: eq(ideaSettings.workspaceId, scope!.workspaceId),
    });
    return {
      portalEnabled: row?.portalEnabled ?? false,
      portalTitle: row?.portalTitle ?? null,
    };
  });
}

export async function updateIdeaSettings(
  ctx: DbStoreContext,
  patch: IdeaSettingsPatch,
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx.query.ideaSettings.findFirst({
      where: eq(ideaSettings.workspaceId, ws),
    });
    const next = {
      portalEnabled: patch.portalEnabled ?? current?.portalEnabled ?? false,
      portalTitle:
        patch.portalTitle !== undefined
          ? patch.portalTitle?.trim()
            ? patch.portalTitle.trim()
            : null
          : (current?.portalTitle ?? null),
    };
    await tx
      .insert(ideaSettings)
      .values({ workspaceId: ws, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: ideaSettings.workspaceId,
        set: { ...next, updatedAt: new Date() },
      });
    return next;
  });
}

/**
 * Load one idea with its derived fields (vote count, viewer vote, author +
 * promotion labels). Used by every single-idea return so create/update/vote
 * all shape the record identically. Returns null when the idea is gone or the
 * acting user can't read its product.
 */
async function hydrateIdea(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  id: string,
): Promise<IdeaRecord | null> {
  const ws = scope.workspaceId;
  const row = await tx.query.ideas.findFirst({
    where: and(eq(ideas.id, id), eq(ideas.workspaceId, ws)),
  });
  if (!row) return null;
  const [access, productById] = await Promise.all([
    ctx.accessIn(tx, scope),
    ctx.productVisibilityIn(tx, ws),
  ]);
  if (!canReadProductId(access, productById, row.productId)) return null;

  const [votes, mine, author, promoted] = await Promise.all([
    tx.select({ n: count() }).from(ideaVotes).where(eq(ideaVotes.ideaId, id)),
    tx
      .select({ id: ideaVotes.id })
      .from(ideaVotes)
      .where(and(eq(ideaVotes.ideaId, id), eq(ideaVotes.userId, scope.userId)))
      .limit(1),
    row.authorId
      ? tx.query.users.findFirst({
          where: eq(users.id, row.authorId),
          columns: { name: true },
        })
      : Promise.resolve(undefined),
    row.promotedFeatureId
      ? tx
          .select({ specId: features.specId, title: features.title })
          .from(features)
          .where(eq(features.id, row.promotedFeatureId))
          .limit(1)
      : Promise.resolve([] as { specId: string; title: string }[]),
  ]);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    productId: row.productId,
    authorName: author?.name ?? null,
    submitterName: row.submitterName,
    voteCount: Number(votes[0]?.n ?? 0),
    viewerHasVoted: mine.length > 0,
    promotedFeatureSpecId: promoted[0]?.specId ?? null,
    promotedFeatureTitle: promoted[0]?.title ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Resolve the effective idea review stages for a workspace (custom or default). */
async function ideaStagesIn(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
): Promise<readonly IdeaStage[]> {
  const rows = await tx
    .select()
    .from(ideaStatuses)
    .where(eq(ideaStatuses.workspaceId, ws))
    .orderBy(asc(ideaStatuses.position));
  return resolveIdeaStages(
    rows.map((r) => ({ key: r.key, label: r.label, position: r.position })),
  );
}
