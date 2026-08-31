/**
 * Cycles, in local file mode.
 *
 * Mirrors db/cycles.ts, including the part that matters: a cycle has no stored
 * status, so its state is computed from its dates on every read and cannot go
 * stale. Rolling one over leaves finished work behind, and what counts as
 * finished is the workflow's terminal stage rather than the literal string
 * "done", which is why this module asks the context for `doneStatusKey`.
 *
 * What is absent is the authorization: file mode has no product roles, so the
 * per-product write checks db/cycles.ts makes have no counterpart here. Every
 * other rule is the same, including name uniqueness per scope, date validation,
 * unscheduling on delete, and finished work staying put on rollover.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compareCycles,
  cycleState,
  generateCycleSchedule,
  todayDateOnly,
  validateCycleDates,
  validateCycleScheduleInput,
} from "@specboards/core";

import {
  CycleError,
  type CycleGenerateInput,
  type CycleInput,
  type CyclePatch,
  type CycleRecord,
  type CycleRolloverResult,
  type WorkspaceScope,
} from "../types";

import { isDone, type LocalStoreContext } from "./context";
import { localPath } from "./paths";

export async function listCycles(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const [rows, all, doneKey] = await Promise.all([
    readCycles(ctx),
    ctx.loadAll(),
    ctx.doneStatusKey(),
  ]);
  const totals = new Map<string, { items: number; done: number }>();
  for (const f of all) {
    if (!f.cycleId) continue;
    const acc = totals.get(f.cycleId) ?? { items: 0, done: 0 };
    acc.items += 1;
    if (isDone(f.status, doneKey)) acc.done += 1;
    totals.set(f.cycleId, acc);
  }
  const today = todayDateOnly();
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      productId: r.productId ?? null,
      startDate: r.startDate,
      endDate: r.endDate,
      notes: r.notes ?? null,
      state: cycleState(r, today),
      itemCount: totals.get(r.id)?.items ?? 0,
      doneCount: totals.get(r.id)?.done ?? 0,
    }))
    .sort((a, b) => compareCycles(a, b, today));
}

export async function createCycle(
  ctx: LocalStoreContext,
  input: CycleInput,
  _scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const name = input.name.trim();
  if (!name) throw new CycleError("Cycle name is required.");
  const dateError = validateCycleDates(input.startDate, input.endDate);
  if (dateError) throw new CycleError(dateError);
  const productId = input.productId ?? null;
  const rows = await readCycles(ctx);
  if (
    rows.some((c) => c.name === name && (c.productId ?? null) === productId)
  ) {
    throw new CycleError(`A cycle named "${name}" already exists.`);
  }
  const cycle: LocalCycle = {
    id: randomUUID(),
    name,
    productId,
    startDate: input.startDate,
    endDate: input.endDate,
    notes: input.notes ?? null,
  };
  await writeCycles(ctx, [...rows, cycle]);
  return {
    id: cycle.id,
    name,
    productId,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
    notes: cycle.notes ?? null,
    state: cycleState(cycle),
    itemCount: 0,
    doneCount: 0,
  };
}

export async function generateCycles(
  ctx: LocalStoreContext,
  input: CycleGenerateInput,
  _scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const error = validateCycleScheduleInput(input);
  if (error) throw new CycleError(error);
  const productId = input.productId ?? null;
  const planned = generateCycleSchedule(input);
  if (planned.length === 0) {
    throw new CycleError(
      "That start date, cycle length and end date produce no cycles.",
    );
  }
  const rows = await readCycles(ctx);
  // Check every name up front so the file is written once, all or nothing.
  // Local mode has no transaction, so a mid-run failure would otherwise
  // leave a partially generated schedule on disk.
  for (const p of planned) {
    if (
      rows.some((c) => c.name === p.name && (c.productId ?? null) === productId)
    ) {
      throw new CycleError(`A cycle named "${p.name}" already exists.`);
    }
  }
  const created: LocalCycle[] = planned.map((p) => ({
    id: randomUUID(),
    name: p.name,
    productId,
    startDate: p.startDate,
    endDate: p.endDate,
    notes: input.notes ?? null,
  }));
  await writeCycles(ctx, [...rows, ...created]);
  return created.map((c) => ({
    id: c.id,
    name: c.name,
    productId,
    startDate: c.startDate,
    endDate: c.endDate,
    notes: c.notes ?? null,
    state: cycleState(c),
    itemCount: 0,
    doneCount: 0,
  }));
}

export async function updateCycle(
  ctx: LocalStoreContext,
  id: string,
  patch: CyclePatch,
  _scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const rows = await readCycles(ctx);
  const cycle = rows.find((c) => c.id === id);
  if (!cycle) throw new CycleError(`Unknown cycle: ${id}`);

  // Validate the dates as they will be after the patch, so moving one end
  // cannot produce a cycle that ends before it starts.
  const startDate = patch.startDate ?? cycle.startDate;
  const endDate = patch.endDate ?? cycle.endDate;
  const dateError = validateCycleDates(startDate, endDate);
  if (dateError) throw new CycleError(dateError);

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new CycleError("Cycle name is required.");
    cycle.name = name;
  }
  if (patch.productId !== undefined) cycle.productId = patch.productId;
  if (patch.startDate !== undefined) cycle.startDate = patch.startDate;
  if (patch.endDate !== undefined) cycle.endDate = patch.endDate;
  if (patch.notes !== undefined) cycle.notes = patch.notes;

  if (
    rows.some(
      (c) =>
        c.id !== id &&
        c.name === cycle.name &&
        (c.productId ?? null) === (cycle.productId ?? null),
    )
  ) {
    throw new CycleError(`A cycle named "${cycle.name}" already exists.`);
  }
  await writeCycles(ctx, rows);
  const listed = await listCycles(ctx);
  return listed.find((c) => c.id === id)!;
}

export async function deleteCycle(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readCycles(ctx);
  if (!rows.some((c) => c.id === id))
    throw new CycleError(`Unknown cycle: ${id}`);
  await writeCycles(
    ctx,
    rows.filter((c) => c.id !== id),
  );
  // Unschedule the deleted cycle's items (mirrors the DB's SET NULL).
  await retargetCycle(ctx, (current) => current === id, null);
}

export async function rolloverCycle(
  ctx: LocalStoreContext,
  fromId: string,
  toId: string,
  _scope?: WorkspaceScope,
): Promise<CycleRolloverResult> {
  if (fromId === toId) {
    throw new CycleError("Pick a different cycle to roll work into.");
  }
  const rows = await readCycles(ctx);
  if (!rows.some((c) => c.id === fromId))
    throw new CycleError(`Unknown cycle: ${fromId}`);
  if (!rows.some((c) => c.id === toId))
    throw new CycleError(`Unknown cycle: ${toId}`);
  // Done and archived work stays in the cycle that delivered (or dropped) it.
  const finished = new Set(
    (await ctx.loadAll())
      .filter((f) => f.status === "done" || f.status === "archived")
      .map((f) => f.specId),
  );
  const moved = await retargetCycle(
    ctx,
    (current) => current === fromId,
    toId,
    finished,
  );
  return { moved, toCycleId: toId };
}

/**
 * The persisted cycle rows.
 *
 * Exported for the same reason `readReleases` is: `createFeature` has to check
 * that a cycle exists and is reachable from the item's product before
 * scheduling into it, which is the items domain asking a cycle question.
 */
export async function readCycles(
  ctx: LocalStoreContext,
): Promise<LocalCycle[]> {
  return ctx.readJsonFile<LocalCycle>(localPath(ctx.root, "cycles"));
}

async function writeCycles(
  ctx: LocalStoreContext,
  rows: LocalCycle[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "cycles")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "cycles"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

/** Set `cycleId` on every item/metadata row matching `match`, returning how
 * many changed. Both stores of item state have to move together in file mode. */
async function retargetCycle(
  ctx: LocalStoreContext,
  match: (current: string | null | undefined) => boolean,
  next: string | null,
  skipSpecIds?: Set<string>,
): Promise<number> {
  let moved = 0;
  const items = await ctx.readItems();
  let itemsChanged = false;
  for (const item of items) {
    if (!match(item.cycleId) || skipSpecIds?.has(item.id)) continue;
    item.cycleId = next;
    itemsChanged = true;
    moved += 1;
  }
  if (itemsChanged) await ctx.writeItems(items);

  const meta = await ctx.readMetadata();
  let metaChanged = false;
  for (const [specId, m] of Object.entries(meta)) {
    if (!match(m.cycleId) || skipSpecIds?.has(specId)) continue;
    m.cycleId = next;
    metaChanged = true;
    moved += 1;
  }
  if (metaChanged) await ctx.writeMetadata(meta);
  return moved;
}

/** A cycle (sprint/iteration) persisted in local file mode. No status field:
 * the state is derived from the dates on read, exactly as in the DB store. */
interface LocalCycle {
  id: string;
  name: string;
  /** Product this cycle belongs to, or null for a workspace-wide cycle. */
  productId?: string | null;
  startDate: string;
  endDate: string;
  notes?: string | null;
}
