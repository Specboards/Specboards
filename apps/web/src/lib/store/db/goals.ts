/**
 * Goals and key results: the outcomes work ladders up to.
 *
 * Authorization mirrors releases and cycles (`canWriteProductId` covers both
 * the per-product and the org-wide/owner-only case). What is different here is
 * visibility on the *link* side: a goal can be served by work in products the
 * caller cannot read, so contributions are filtered to the readable set while
 * the goal itself stays visible. Hiding the goal because one of its
 * contributors is out of reach would make org-wide goals invisible to almost
 * everyone.
 *
 * The two progress figures on a goal are computed here and never stored. The
 * key-result mean measures the outcome; the delivery share measures how much
 * of the linked work has shipped. They stay separate because a goal whose work
 * is all done but whose numbers have not moved is a real and important state,
 * and averaging the two would hide it.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  compareGoals,
  deliveryProgress,
  goalProgress,
  isGoalStatus,
  keyResultProgress,
  validateGoalPeriod,
  validateKeyResult,
  wouldCreateGoalCycle,
  type GoalStatus,
  type MetricKind,
} from "@specboards/core";

import {
  and,
  asc,
  count,
  eq,
  features,
  goalLinks,
  goals,
  keyResults,
} from "@specboards/db";

import {
  GoalError,
  type GoalContribution,
  type GoalInput,
  type GoalLinkRef,
  type GoalPatch,
  type GoalRecord,
  type ItemGoalRef,
  type KeyResultInput,
  type KeyResultPatch,
  type WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  canWriteProductId,
  doneStatusesIn,
  type DbStoreContext,
  type Tx,
} from "./context";
export async function listGoals(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<GoalRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [goalRows, krRows, access, productById, done] = await Promise.all([
      tx.select().from(goals).where(eq(goals.workspaceId, ws)),
      // Same ordering as hydrateGoal, and for the same reason. This is the
      // list page, so an unordered read here is the one most people see.
      tx
        .select()
        .from(keyResults)
        .where(eq(keyResults.workspaceId, ws))
        .orderBy(asc(keyResults.position), asc(keyResults.createdAt)),
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
      doneStatusesIn(tx, ws),
    ]);
    // Link counts are computed over readable work only, so a goal never
    // advertises progress from items the caller cannot see.
    const linkRows = await tx
      .select({
        goalId: goalLinks.goalId,
        status: features.status,
        productId: features.productId,
      })
      .from(goalLinks)
      .innerJoin(features, eq(features.id, goalLinks.featureId))
      .where(eq(goalLinks.workspaceId, ws));

    const byGoal = new Map<string, { done: boolean }[]>();
    for (const row of linkRows) {
      if (!canReadProductId(access, productById, row.productId)) continue;
      const list = byGoal.get(row.goalId) ?? [];
      list.push({ done: done.isDone(row.status, row.productId) });
      byGoal.set(row.goalId, list);
    }

    const krByGoal = new Map<string, typeof krRows>();
    for (const kr of krRows) {
      const list = krByGoal.get(kr.goalId) ?? [];
      list.push(kr);
      krByGoal.set(kr.goalId, list);
    }

    return goalRows
      .filter((g) => canReadProductId(access, productById, g.productId))
      .map((g) =>
        toGoalRecord(g, krByGoal.get(g.id) ?? [], byGoal.get(g.id) ?? []),
      )
      .sort(compareGoals);
  });
}

export async function createGoal(
  ctx: DbStoreContext,
  input: GoalInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const title = input.title.trim();
    if (!title) throw new GoalError("Goal title is required.");
    const periodError = validateGoalPeriod(
      input.periodStart ?? null,
      input.periodEnd ?? null,
    );
    if (periodError) throw new GoalError(periodError);
    const productId = input.productId ?? null;
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, productId)) {
      throw new GoalError(
        productId === null
          ? "Only the workspace owner can create org-wide goals."
          : "Your role does not permit creating goals for this product.",
      );
    }
    if (productId !== null) await ctx.requireProductId(tx, ws, productId);
    if (input.parentGoalId) {
      await requireGoalId(ctx, tx, ws, input.parentGoalId);
    }
    const status = input.status ?? "on_track";
    if (!isGoalStatus(status)) {
      throw new GoalError(`Unknown goal status: ${status}`);
    }
    const [row] = await tx
      .insert(goals)
      .values({
        workspaceId: ws,
        productId,
        title,
        description: input.description ?? null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        parentGoalId: input.parentGoalId ?? null,
        status,
      })
      .returning();
    if (!row) throw new GoalError("Failed to create the goal.");
    return toGoalRecord(row, [], []);
  });
}

export async function updateGoal(
  ctx: DbStoreContext,
  id: string,
  patch: GoalPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.workspaceId, ws)))
      .limit(1);
    if (!current) throw new GoalError(`Unknown goal: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current.productId)) {
      throw new GoalError(
        current.productId === null
          ? "Only the workspace owner can edit org-wide goals."
          : "Your role does not permit editing goals for this product.",
      );
    }

    // Validate the period as it will be after the patch, so moving one end
    // cannot produce a period that ends before it starts.
    const periodStart =
      patch.periodStart !== undefined ? patch.periodStart : current.periodStart;
    const periodEnd =
      patch.periodEnd !== undefined ? patch.periodEnd : current.periodEnd;
    const periodError = validateGoalPeriod(periodStart, periodEnd);
    if (periodError) throw new GoalError(periodError);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new GoalError("Goal title is required.");
      set.title = title;
    }
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.periodStart !== undefined) set.periodStart = patch.periodStart;
    if (patch.periodEnd !== undefined) set.periodEnd = patch.periodEnd;
    if (patch.status !== undefined) {
      if (!isGoalStatus(patch.status)) {
        throw new GoalError(`Unknown goal status: ${patch.status}`);
      }
      set.status = patch.status;
    }
    if (patch.parentGoalId !== undefined) {
      if (patch.parentGoalId !== null) {
        await requireGoalId(ctx, tx, ws, patch.parentGoalId);
        const all = await tx
          .select({ id: goals.id, parentGoalId: goals.parentGoalId })
          .from(goals)
          .where(eq(goals.workspaceId, ws));
        if (wouldCreateGoalCycle(all, id, patch.parentGoalId)) {
          throw new GoalError("A goal cannot be nested under itself.");
        }
      }
      set.parentGoalId = patch.parentGoalId;
    }
    if (
      patch.productId !== undefined &&
      patch.productId !== current.productId
    ) {
      if (!canWriteProductId(access, patch.productId)) {
        throw new GoalError(
          patch.productId === null
            ? "Only the workspace owner can make a goal org-wide."
            : "Your role does not permit moving a goal to that product.",
        );
      }
      if (patch.productId !== null) {
        await ctx.requireProductId(tx, ws, patch.productId);
      }
      set.productId = patch.productId;
      // Deliberately NOT unlinking work from other products, unlike a release
      // or cycle move. A goal is many-to-many and cross-product by design;
      // narrowing its scope does not make the work that served it untrue.
    }

    const [row] = await tx
      .update(goals)
      .set(set)
      .where(and(eq(goals.id, id), eq(goals.workspaceId, ws)))
      .returning();
    if (!row) throw new GoalError(`Unknown goal: ${id}`);
    return hydrateGoal(ctx, tx, scope!, row);
  });
}

export async function deleteGoal(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select({ productId: goals.productId })
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.workspaceId, ws)))
      .limit(1);
    if (!current) throw new GoalError(`Unknown goal: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current.productId)) {
      throw new GoalError(
        current.productId === null
          ? "Only the workspace owner can delete org-wide goals."
          : "Your role does not permit deleting goals for this product.",
      );
    }
    // key_results and goal_links cascade; child goals are ON DELETE SET NULL,
    // so they are orphaned to the root rather than deleted with their parent.
    // The work items on the other end of the links are untouched.
    await tx
      .delete(goals)
      .where(and(eq(goals.id, id), eq(goals.workspaceId, ws)));
  });
}

export async function createKeyResult(
  ctx: DbStoreContext,
  goalId: string,
  input: KeyResultInput,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const goal = await requireWritableGoal(ctx, tx, scope!, goalId);
    const title = input.title.trim();
    if (!title) throw new GoalError("Key result title is required.");
    const metricKind = input.metricKind ?? "number";
    const startValue = input.startValue ?? 0;
    const error = validateKeyResult({
      metricKind,
      startValue,
      targetValue: input.targetValue,
    });
    if (error) throw new GoalError(error);
    const [existing] = await tx
      .select({ n: count() })
      .from(keyResults)
      .where(eq(keyResults.goalId, goalId));
    await tx.insert(keyResults).values({
      workspaceId: ws,
      goalId,
      title,
      metricKind,
      startValue,
      targetValue: input.targetValue,
      currentValue: input.currentValue ?? startValue,
      position: Number(existing?.n ?? 0),
    });
    return hydrateGoal(ctx, tx, scope!, goal);
  });
}

export async function updateKeyResult(
  ctx: DbStoreContext,
  id: string,
  patch: KeyResultPatch,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select()
      .from(keyResults)
      .where(and(eq(keyResults.id, id), eq(keyResults.workspaceId, ws)))
      .limit(1);
    if (!current) throw new GoalError(`Unknown key result: ${id}`);
    const goal = await requireWritableGoal(ctx, tx, scope!, current.goalId);

    // Validate the measure as it will be, so patching one value can't leave a
    // key result whose progress is undefined.
    const metricKind = patch.metricKind ?? (current.metricKind as MetricKind);
    const startValue = patch.startValue ?? current.startValue;
    const targetValue = patch.targetValue ?? current.targetValue;
    const error = validateKeyResult({ metricKind, startValue, targetValue });
    if (error) throw new GoalError(error);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new GoalError("Key result title is required.");
      set.title = title;
    }
    if (patch.metricKind !== undefined) set.metricKind = patch.metricKind;
    if (patch.startValue !== undefined) set.startValue = patch.startValue;
    if (patch.targetValue !== undefined) set.targetValue = patch.targetValue;
    if (patch.currentValue !== undefined) set.currentValue = patch.currentValue;
    if (patch.position !== undefined) set.position = patch.position;

    await tx
      .update(keyResults)
      .set(set)
      .where(and(eq(keyResults.id, id), eq(keyResults.workspaceId, ws)));
    return hydrateGoal(ctx, tx, scope!, goal);
  });
}

export async function deleteKeyResult(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<GoalRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select({ goalId: keyResults.goalId })
      .from(keyResults)
      .where(and(eq(keyResults.id, id), eq(keyResults.workspaceId, ws)))
      .limit(1);
    if (!current) throw new GoalError(`Unknown key result: ${id}`);
    const goal = await requireWritableGoal(ctx, tx, scope!, current.goalId);
    await tx
      .delete(keyResults)
      .where(and(eq(keyResults.id, id), eq(keyResults.workspaceId, ws)));
    return hydrateGoal(ctx, tx, scope!, goal);
  });
}

export async function listGoalContributions(
  ctx: DbStoreContext,
  goalId: string,
  scope?: WorkspaceScope,
): Promise<GoalContribution[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [access, productById, done] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
      doneStatusesIn(tx, ws),
    ]);
    const rows = await tx
      .select({
        specId: features.specId,
        title: features.title,
        status: features.status,
        level: features.level,
        productId: features.productId,
      })
      .from(goalLinks)
      .innerJoin(features, eq(features.id, goalLinks.featureId))
      .where(and(eq(goalLinks.workspaceId, ws), eq(goalLinks.goalId, goalId)));
    // A viewer sees only the linked items they can read; the goal stays
    // visible regardless (see the section comment).
    return rows
      .filter((r) => canReadProductId(access, productById, r.productId))
      .map((r) => ({ ...r, done: done.isDone(r.status, r.productId) }));
  });
}

export async function listGoalLinks(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<GoalLinkRef[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    const rows = await tx
      .select({
        goalId: goalLinks.goalId,
        specId: features.specId,
        productId: features.productId,
      })
      .from(goalLinks)
      .innerJoin(features, eq(features.id, goalLinks.featureId))
      .where(eq(goalLinks.workspaceId, ws));
    // Same rule as listGoalContributions: the link is dropped when its work
    // is unreadable, and the goal stays visible regardless.
    return rows
      .filter((r) => canReadProductId(access, productById, r.productId))
      .map((r) => ({ goalId: r.goalId, specId: r.specId }));
  });
}

export async function listItemGoals(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<ItemGoalRef[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    const rows = await tx
      .select({
        goalId: goals.id,
        title: goals.title,
        status: goals.status,
        productId: goals.productId,
      })
      .from(goalLinks)
      .innerJoin(goals, eq(goals.id, goalLinks.goalId))
      .innerJoin(features, eq(features.id, goalLinks.featureId))
      .where(and(eq(goalLinks.workspaceId, ws), eq(features.specId, specId)));
    return rows
      .filter((r) => canReadProductId(access, productById, r.productId))
      .map((r) => ({ ...r, status: r.status as GoalStatus }));
  });
}

export async function linkGoal(
  ctx: DbStoreContext,
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    await requireWritableGoal(ctx, tx, scope!, goalId);
    const [feature] = await tx
      .select({ id: features.id, productId: features.productId })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
      .limit(1);
    if (!feature) throw new GoalError(`Unknown work item: ${specId}`);
    const access = await ctx.accessIn(tx, scope!);
    // Linking writes to the item's side of the relationship as much as the
    // goal's, so it needs write access to the item's product too. Note there
    // is deliberately NO check that the two products match: cross-product
    // linkage is the point of the join table.
    if (!canWriteProductId(access, feature.productId)) {
      throw new GoalError(
        "Your role does not permit linking work from this product.",
      );
    }
    await tx
      .insert(goalLinks)
      .values({ workspaceId: ws, goalId, featureId: feature.id })
      // Linking twice is a no-op rather than an error: the caller's intent
      // ("this work serves that goal") is already true.
      .onConflictDoNothing({
        target: [goalLinks.goalId, goalLinks.featureId],
      });
  });
}

export async function unlinkGoal(
  ctx: DbStoreContext,
  goalId: string,
  specId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    await requireWritableGoal(ctx, tx, scope!, goalId);
    const [feature] = await tx
      .select({ id: features.id })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
      .limit(1);
    if (!feature) throw new GoalError(`Unknown work item: ${specId}`);
    await tx
      .delete(goalLinks)
      .where(
        and(
          eq(goalLinks.workspaceId, ws),
          eq(goalLinks.goalId, goalId),
          eq(goalLinks.featureId, feature.id),
        ),
      );
  });
}

/** Resolve a goal the caller may write, or throw. */
async function requireWritableGoal(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  goalId: string,
): Promise<typeof goals.$inferSelect> {
  const [goal] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.workspaceId, scope.workspaceId)))
    .limit(1);
  if (!goal) throw new GoalError(`Unknown goal: ${goalId}`);
  const access = await ctx.accessIn(tx, scope);
  if (!canWriteProductId(access, goal.productId)) {
    throw new GoalError(
      goal.productId === null
        ? "Only the workspace owner can edit org-wide goals."
        : "Your role does not permit editing goals for this product.",
    );
  }
  return goal;
}

/** Confirm a goal id belongs to this workspace. */
async function requireGoalId(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  goalId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.workspaceId, ws)))
    .limit(1);
  if (!row) throw new GoalError(`Unknown goal: ${goalId}`);
}

/** Re-read one goal's key results + readable links and build its record. */
async function hydrateGoal(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  goal: typeof goals.$inferSelect,
): Promise<GoalRecord> {
  const ws = scope.workspaceId;
  const [krs, linkRows, access, productById, done] = await Promise.all([
    // Ordered by the column that exists for it. `position` is set on insert
    // and was never read here, which left display order to whatever Postgres
    // returned: not merely arbitrary but unstable, since a row can move on
    // UPDATE, so checking in one key result's value could reshuffle the list
    // under the person doing it. `createdAt` breaks ties because nothing
    // stops two rows sharing a position, and a tie without a tiebreaker is
    // the same instability in a smaller place.
    tx
      .select()
      .from(keyResults)
      .where(eq(keyResults.goalId, goal.id))
      .orderBy(asc(keyResults.position), asc(keyResults.createdAt)),
    tx
      .select({ status: features.status, productId: features.productId })
      .from(goalLinks)
      .innerJoin(features, eq(features.id, goalLinks.featureId))
      .where(and(eq(goalLinks.workspaceId, ws), eq(goalLinks.goalId, goal.id))),
    ctx.accessIn(tx, scope),
    ctx.productVisibilityIn(tx, ws),
    doneStatusesIn(tx, ws),
  ]);
  const links = linkRows
    .filter((r) => canReadProductId(access, productById, r.productId))
    .map((r) => ({ done: done.isDone(r.status, r.productId) }));
  return toGoalRecord(goal, krs, links);
}

/**
 * Map a goals row (+ its key results and readable links) to the record the UI
 * consumes. Both progress figures are computed here and never stored: the
 * key-result mean measures the outcome, the delivery share measures how much of
 * the linked work has shipped, and they stay separate because a goal where
 * everything shipped and nothing moved is exactly what OKRs exist to surface.
 */
function toGoalRecord(
  row: {
    id: string;
    title: string;
    description: string | null;
    productId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    parentGoalId: string | null;
    status: string;
  },
  krRows: {
    id: string;
    goalId: string;
    title: string;
    metricKind: string;
    startValue: number;
    targetValue: number;
    currentValue: number;
    position: number;
  }[],
  links: { done: boolean }[],
): GoalRecord {
  const measures = krRows
    .slice()
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .map((kr) => ({
      id: kr.id,
      goalId: kr.goalId,
      title: kr.title,
      metricKind: kr.metricKind as MetricKind,
      startValue: kr.startValue,
      targetValue: kr.targetValue,
      currentValue: kr.currentValue,
      position: kr.position,
    }));
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    productId: row.productId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    parentGoalId: row.parentGoalId,
    status: row.status as GoalStatus,
    keyResults: measures.map((kr) => ({
      ...kr,
      progress: keyResultProgress(kr),
    })),
    progress: goalProgress(measures),
    linkedItemCount: links.length,
    deliveryProgress: deliveryProgress(links),
  };
}
