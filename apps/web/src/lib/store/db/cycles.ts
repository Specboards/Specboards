/**
 * Cycles: the sprint or iteration a piece of work is scheduled into.
 *
 * Deliberately parallel to the release methods: same product-scoped
 * authorization (`canWriteProductId` handles both the per-product and the
 * workspace-wide/owner-only case), same name-uniqueness pre-check against the
 * two partial unique indexes, same set-null unscheduling on delete. The one
 * difference is that a cycle has no stored status: `state` is computed from
 * the dates on every read, so nothing can go stale.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  compareCycles,
  cycleState,
  generateCycleSchedule,
  todayDateOnly,
  validateCycleDates,
  validateCycleScheduleInput,
} from "@specboards/core";

import {
  and,
  count,
  cycles,
  eq,
  features,
  inArray,
  isNull,
  ne,
  not,
} from "@specboards/db";

import {
  CycleError,
  type CycleGenerateInput,
  type CycleInput,
  type CyclePatch,
  type CycleRecord,
  type CycleRolloverResult,
  type WorkspaceScope,
} from "../types";

import {
  canWriteProductId,
  isDone,
  type DbStoreContext,
  type Tx,
} from "./context";

export async function listCycles(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, counts] = await Promise.all([
      tx.select().from(cycles).where(eq(cycles.workspaceId, ws)),
      tx
        .select({
          cycleId: features.cycleId,
          status: features.status,
          n: count(),
        })
        .from(features)
        .where(eq(features.workspaceId, ws))
        .groupBy(features.cycleId, features.status),
    ]);
    const totals = new Map<string, { items: number; done: number }>();
    for (const c of counts) {
      if (!c.cycleId) continue;
      const acc = totals.get(c.cycleId) ?? { items: 0, done: 0 };
      acc.items += Number(c.n);
      if (isDone(c.status)) acc.done += Number(c.n);
      totals.set(c.cycleId, acc);
    }
    const today = todayDateOnly();
    return rows
      .map((r) => toCycleRecord(r, totals.get(r.id), today))
      .sort((a, b) => compareCycles(a, b, today));
  });
}

export async function createCycle(
  ctx: DbStoreContext,
  input: CycleInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const name = input.name.trim();
    if (!name) throw new CycleError("Cycle name is required.");
    const dateError = validateCycleDates(input.startDate, input.endDate);
    if (dateError) throw new CycleError(dateError);
    const productId = input.productId ?? null;
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, productId)) {
      throw new CycleError(
        productId === null
          ? "Only the workspace owner can create workspace-wide cycles."
          : "Your role does not permit creating cycles for this product.",
      );
    }
    if (productId !== null) {
      await ctx.requireProductId(tx, ws, productId);
    }
    await assertCycleNameFree(tx, ws, name, productId, null);
    const [row] = await tx
      .insert(cycles)
      .values({
        workspaceId: ws,
        productId,
        name,
        startDate: input.startDate,
        endDate: input.endDate,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new CycleError(`A cycle named "${name}" already exists.`);
    return toCycleRecord(row, undefined, todayDateOnly());
  });
}

export async function generateCycles(
  ctx: DbStoreContext,
  input: CycleGenerateInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const error = validateCycleScheduleInput(input);
    if (error) throw new CycleError(error);
    const productId = input.productId ?? null;
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, productId)) {
      throw new CycleError(
        productId === null
          ? "Only the workspace owner can create workspace-wide cycles."
          : "Your role does not permit creating cycles for this product.",
      );
    }
    if (productId !== null) {
      await ctx.requireProductId(tx, ws, productId);
    }

    const planned = generateCycleSchedule(input);
    if (planned.length === 0) {
      throw new CycleError(
        "That start date, cycle length and end date produce no cycles.",
      );
    }
    // Check every name before inserting any. `scoped` runs this in a
    // transaction, so a clash rolls the whole run back: a half-generated
    // schedule is worse than none, because the user cannot tell which cycles
    // are theirs and re-running would collide with what did land.
    for (const p of planned) {
      await assertCycleNameFree(tx, ws, p.name, productId, null);
    }

    const rows = await tx
      .insert(cycles)
      .values(
        planned.map((p) => ({
          workspaceId: ws,
          productId,
          name: p.name,
          startDate: p.startDate,
          endDate: p.endDate,
          notes: input.notes ?? null,
        })),
      )
      .returning();
    const today = todayDateOnly();
    return rows
      .map((r) => toCycleRecord(r, undefined, today))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  });
}

export async function updateCycle(
  ctx: DbStoreContext,
  id: string,
  patch: CyclePatch,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select({
        productId: cycles.productId,
        name: cycles.name,
        startDate: cycles.startDate,
        endDate: cycles.endDate,
      })
      .from(cycles)
      .where(and(eq(cycles.id, id), eq(cycles.workspaceId, ws)))
      .limit(1);
    if (!current) throw new CycleError(`Unknown cycle: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current.productId)) {
      throw new CycleError(
        current.productId === null
          ? "Only the workspace owner can edit workspace-wide cycles."
          : "Your role does not permit editing cycles for this product.",
      );
    }

    // Validate the dates as they will be *after* the patch, so moving one end
    // can't produce a cycle that ends before it starts.
    const startDate = patch.startDate ?? current.startDate;
    const endDate = patch.endDate ?? current.endDate;
    const dateError = validateCycleDates(startDate, endDate);
    if (dateError) throw new CycleError(dateError);

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new CycleError("Cycle name is required.");
      set.name = name;
    }
    if (patch.startDate !== undefined) set.startDate = patch.startDate;
    if (patch.endDate !== undefined) set.endDate = patch.endDate;
    if (patch.notes !== undefined) set.notes = patch.notes;

    // Moving to a different product needs write access to the destination
    // too, and unschedules items that no longer match (mirrors updateRelease).
    let targetProductId = current.productId;
    if (
      patch.productId !== undefined &&
      patch.productId !== current.productId
    ) {
      targetProductId = patch.productId;
      if (!canWriteProductId(access, targetProductId)) {
        throw new CycleError(
          targetProductId === null
            ? "Only the workspace owner can move a cycle to the workspace scope."
            : "Your role does not permit moving a cycle to that product.",
        );
      }
      if (targetProductId !== null) {
        await ctx.requireProductId(tx, ws, targetProductId);
      }
      set.productId = targetProductId;
    }

    if (set.name !== undefined || set.productId !== undefined) {
      await assertCycleNameFree(
        tx,
        ws,
        (set.name as string | undefined) ?? current.name,
        targetProductId,
        id,
      );
    }

    const [row] = await tx
      .update(cycles)
      .set(set)
      .where(and(eq(cycles.id, id), eq(cycles.workspaceId, ws)))
      .returning();
    if (!row) throw new CycleError(`Unknown cycle: ${id}`);
    if (set.productId !== undefined && targetProductId !== null) {
      await tx
        .update(features)
        .set({ cycleId: null, updatedAt: new Date() })
        .where(
          and(
            eq(features.workspaceId, ws),
            eq(features.cycleId, id),
            ne(features.productId, targetProductId),
          ),
        );
    }
    return toCycleRecord(row, await cycleTotals(tx, ws, id), todayDateOnly());
  });
}

export async function deleteCycle(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [current] = await tx
      .select({ productId: cycles.productId })
      .from(cycles)
      .where(and(eq(cycles.id, id), eq(cycles.workspaceId, ws)))
      .limit(1);
    if (!current) throw new CycleError(`Unknown cycle: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current.productId)) {
      throw new CycleError(
        current.productId === null
          ? "Only the workspace owner can delete workspace-wide cycles."
          : "Your role does not permit deleting cycles for this product.",
      );
    }
    // features.cycle_id is ON DELETE SET NULL, so items are unscheduled.
    await tx
      .delete(cycles)
      .where(and(eq(cycles.id, id), eq(cycles.workspaceId, ws)));
  });
}

export async function rolloverCycle(
  ctx: DbStoreContext,
  fromId: string,
  toId: string,
  scope?: WorkspaceScope,
): Promise<CycleRolloverResult> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    if (fromId === toId) {
      throw new CycleError("Pick a different cycle to roll work into.");
    }
    const rows = await tx
      .select({
        id: cycles.id,
        productId: cycles.productId,
        endDate: cycles.endDate,
      })
      .from(cycles)
      .where(and(eq(cycles.workspaceId, ws), inArray(cycles.id, [fromId, toId])));
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from) throw new CycleError(`Unknown cycle: ${fromId}`);
    if (!to) throw new CycleError(`Unknown cycle: ${toId}`);
    const access = await ctx.accessIn(tx, scope!);
    // Both ends are written to, so both need write access.
    if (!canWriteProductId(access, from.productId) ||
        !canWriteProductId(access, to.productId)) {
      throw new CycleError(
        "Your role does not permit moving work between these cycles.",
      );
    }
    // A product cycle can only take work from that product. A workspace-wide
    // destination takes anything, matching the scheduling rule.
    const productGuard =
      to.productId === null
        ? undefined
        : eq(features.productId, to.productId);

    const moved = await tx
      .update(features)
      .set({ cycleId: toId, updatedAt: new Date() })
      .where(
        and(
          eq(features.workspaceId, ws),
          eq(features.cycleId, fromId),
          // Finished (and archived) work stays put, so the closed cycle
          // keeps an honest record of what it actually delivered.
          not(inArray(features.status, NOT_ROLLED_OVER)),
          ...(productGuard ? [productGuard] : []),
        ),
      )
      .returning({ id: features.id });
    return { moved: moved.length, toCycleId: toId };
  });
}

/** Item and done counts for one cycle (used after a write). */
async function cycleTotals(
  tx: Tx,
  ws: string,
  cycleId: string,
): Promise<{ items: number; done: number }> {
  const rows = await tx
    .select({ status: features.status, n: count() })
    .from(features)
    .where(and(eq(features.workspaceId, ws), eq(features.cycleId, cycleId)))
    .groupBy(features.status);
  let items = 0;
  let done = 0;
  for (const r of rows) {
    items += Number(r.n);
    if (isDone(r.status)) done += Number(r.n);
  }
  return { items, done };
}

/**
 * Guard the scoped unique name. Pre-checked rather than relying on ON
 * CONFLICT because the partial unique indexes can't be named as an arbiter
 * without their predicate, which drizzle omits (same reason as releases).
 */
async function assertCycleNameFree(
  tx: Tx,
  ws: string,
  name: string,
  productId: string | null,
  excludeId: string | null,
): Promise<void> {
  const clash = await tx
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(
        eq(cycles.workspaceId, ws),
        eq(cycles.name, name),
        productId === null
          ? isNull(cycles.productId)
          : eq(cycles.productId, productId),
        ...(excludeId ? [ne(cycles.id, excludeId)] : []),
      ),
    )
    .limit(1);
  if (clash[0]) {
    throw new CycleError(`A cycle named "${name}" already exists.`);
  }
}

/**
 * Statuses a cycle rollover leaves behind. Done work stays in the cycle that
 * delivered it, so the closed cycle keeps an honest record; archived work is
 * not carried into a new cycle either, since archiving is how a team says they
 * are not doing it. Broader than `isDone`, which answers a different question
 * (how much of this is finished) and must not count archived items as done.
 */
const NOT_ROLLED_OVER = ["done", "archived"];

/**
 * Map a cycles row to the record the UI consumes, computing `state` from the
 * dates rather than reading a column (there isn't one). `totals` is omitted on
 * a freshly created cycle, which by definition holds nothing yet.
 */
function toCycleRecord(
  row: {
    id: string;
    name: string;
    productId: string | null;
    startDate: string;
    endDate: string;
    notes: string | null;
  },
  totals: { items: number; done: number } | undefined,
  today: string,
): CycleRecord {
  return {
    id: row.id,
    name: row.name,
    productId: row.productId,
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
    state: cycleState(row, today),
    itemCount: totals?.items ?? 0,
    doneCount: totals?.done ?? 0,
  };
}
