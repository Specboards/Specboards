/**
 * Releases: the version a piece of work is scheduled to ship in.
 *
 * The sibling of ./cycles.ts, and the differences between the two are the
 * interesting part. A release carries a stored `status`, so shipping one has
 * to stamp `shipped_date` and reopening one has to clear it; a cycle's state
 * is derived from its dates and cannot go stale. A release also emits to the
 * outbox on update, because "released" is a fact the outside world subscribes
 * to, and a cycle rolling over is not.
 *
 * What they share is the authorization shape: `canWriteProductId` covers both
 * the per-product case and the portfolio (null-product) case, which is
 * owner-only, and name uniqueness is pre-checked rather than left to the
 * partial unique indexes, whose predicates drizzle cannot name as an arbiter.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  shippedDateAfterWrite,
  shippedDateError,
  todayDateOnly,
} from "@specboards/core";

import { and, count, eq, features, isNull, ne, releases } from "@specboards/db";

import {
  compareReleases,
  ReleaseError,
  RELEASE_STATUSES,
  type OutboxEmit,
  type ReleaseInput,
  type ReleaseNotesMode,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
  type WorkspaceScope,
} from "../types";

import {
  canWriteProductId,
  toCustomFields,
  type DbStoreContext,
} from "./context";

export async function listReleases(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [rows, counts] = await Promise.all([
      tx.select().from(releases).where(eq(releases.workspaceId, ws)),
      tx
        .select({ releaseId: features.releaseId, n: count() })
        .from(features)
        .where(eq(features.workspaceId, ws))
        .groupBy(features.releaseId),
    ]);
    const countById = new Map<string, number>();
    for (const c of counts) {
      if (c.releaseId) countById.set(c.releaseId, Number(c.n));
    }
    return rows
      .map((r) => toReleaseRecord(r, countById.get(r.id) ?? 0))
      .sort(compareReleases);
  });
}

export async function createRelease(
  ctx: DbStoreContext,
  input: ReleaseInput,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const name = input.name.trim();
    if (!name) throw new ReleaseError("Release name is required.");
    const productId = input.productId ?? null;
    const access = await ctx.accessIn(tx, scope!);
    // Product releases need write access to that product; portfolio
    // (null-product) releases are owner-only (canWriteProductId handles both).
    if (!canWriteProductId(access, productId)) {
      throw new ReleaseError(
        productId === null
          ? "Only the workspace owner can create portfolio releases."
          : "Your role does not permit creating releases for this product.",
      );
    }
    if (productId !== null) {
      await ctx.requireProductId(tx, ws, productId);
    }
    // Names are unique within a product (and within the portfolio scope).
    // Pre-check rather than ON CONFLICT: the partial unique indexes can't be
    // named as an arbiter without their predicate, which drizzle omits.
    const clash = await tx
      .select({ id: releases.id })
      .from(releases)
      .where(
        and(
          eq(releases.workspaceId, ws),
          eq(releases.name, name),
          productId === null
            ? isNull(releases.productId)
            : eq(releases.productId, productId),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw new ReleaseError(`A release named "${name}" already exists.`);
    }
    // `shipped_date` describes the state rather than the transition that
    // reached it, so a release created already shipped gets one here. The rule
    // is core's, shared with updateRelease and the local store, so all three
    // agree on when today is stamped and when a named date wins. See
    // core/releases.ts.
    const status = normalizeReleaseStatus(input.status);
    const shipped = status === "shipped";
    const dateError = shippedDateError(input.shippedDate, shipped);
    if (dateError) throw new ReleaseError(dateError);
    const [row] = await tx
      .insert(releases)
      .values({
        workspaceId: ws,
        productId,
        name,
        status,
        shippedDate: shippedDateAfterWrite({
          shipped,
          previous: null,
          explicit: input.shippedDate,
          today: todayDateOnly(),
        }),
        startDate: input.startDate ?? null,
        targetDate: input.targetDate ?? null,
        notes: input.notes ?? null,
        releaseNotesMode: input.releaseNotesMode ?? "none",
        releaseNotesBody: input.releaseNotesBody ?? null,
        releaseNotesUrl: input.releaseNotesUrl ?? null,
        customFields: input.customFields ?? {},
      })
      .returning();
    if (!row)
      throw new ReleaseError(`A release named "${name}" already exists.`);
    return toReleaseRecord(row, 0);
  });
}

export async function updateRelease(
  ctx: DbStoreContext,
  id: string,
  patch: ReleasePatch,
  scope?: WorkspaceScope,
  emit?: OutboxEmit,
): Promise<ReleaseRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx
      .select({
        productId: releases.productId,
        name: releases.name,
        status: releases.status,
        shippedDate: releases.shippedDate,
      })
      .from(releases)
      .where(and(eq(releases.id, id), eq(releases.workspaceId, ws)))
      .limit(1);
    if (!current[0]) throw new ReleaseError(`Unknown release: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current[0].productId)) {
      throw new ReleaseError(
        current[0].productId === null
          ? "Only the workspace owner can edit portfolio releases."
          : "Your role does not permit editing releases for this product.",
      );
    }

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ReleaseError("Release name is required.");
      set.name = name;
    }
    if (patch.status !== undefined) {
      set.status = normalizeReleaseStatus(patch.status);
    }
    // The ship date is recomputed whenever the status or the date itself is in
    // the patch, and left alone otherwise so an unrelated edit cannot move it.
    // Everything the rule decides (stamp today on first ship, keep the stored
    // date across edits, take a named date so a past release can be recorded or
    // a wrong one corrected, clear on reopen) is in core/releases.ts, shared
    // with createRelease and with the local store. The planned target_date is a
    // different fact and is never touched here.
    if (patch.status !== undefined || patch.shippedDate !== undefined) {
      const shipped =
        (patch.status !== undefined
          ? normalizeReleaseStatus(patch.status)
          : current[0].status) === "shipped";
      const dateError = shippedDateError(patch.shippedDate, shipped);
      if (dateError) throw new ReleaseError(dateError);
      set.shippedDate = shippedDateAfterWrite({
        shipped,
        previous: current[0].shippedDate,
        explicit: patch.shippedDate,
        today: todayDateOnly(),
      });
    }
    if (patch.startDate !== undefined) set.startDate = patch.startDate;
    if (patch.targetDate !== undefined) set.targetDate = patch.targetDate;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.releaseNotesMode !== undefined)
      set.releaseNotesMode = patch.releaseNotesMode;
    if (patch.releaseNotesBody !== undefined)
      set.releaseNotesBody = patch.releaseNotesBody;
    if (patch.releaseNotesUrl !== undefined)
      set.releaseNotesUrl = patch.releaseNotesUrl;
    // Custom fields replace the whole map (mirrors features): the caller sends
    // the complete, merged set of release-scoped values.
    if (patch.customFields !== undefined) set.customFields = patch.customFields;

    // Reassigning to a different product (or to portfolio) also needs write
    // access to the destination, and unschedules items that no longer match.
    let targetProductId = current[0].productId;
    if (
      patch.productId !== undefined &&
      patch.productId !== current[0].productId
    ) {
      targetProductId = patch.productId;
      if (!canWriteProductId(access, targetProductId)) {
        throw new ReleaseError(
          targetProductId === null
            ? "Only the workspace owner can move a release to the portfolio."
            : "Your role does not permit moving a release to that product.",
        );
      }
      if (targetProductId !== null) {
        await ctx.requireProductId(tx, ws, targetProductId);
      }
      set.productId = targetProductId;
    }

    // Guard the scoped unique name (a rename or product move can collide).
    if (set.name !== undefined || set.productId !== undefined) {
      const effectiveName = (set.name as string | undefined) ?? current[0].name;
      const clash = await tx
        .select({ id: releases.id })
        .from(releases)
        .where(
          and(
            eq(releases.workspaceId, ws),
            eq(releases.name, effectiveName),
            targetProductId === null
              ? isNull(releases.productId)
              : eq(releases.productId, targetProductId),
            ne(releases.id, id),
          ),
        )
        .limit(1);
      if (clash[0]) {
        throw new ReleaseError(
          `A release named "${effectiveName}" already exists.`,
        );
      }
    }

    const [row] = await tx
      .update(releases)
      .set(set)
      .where(and(eq(releases.id, id), eq(releases.workspaceId, ws)))
      .returning();
    if (!row) throw new ReleaseError(`Unknown release: ${id}`);
    // Moving to a specific product drops items that belong to other products,
    // preserving the invariant that a scheduled item shares the release's product.
    if (set.productId !== undefined && targetProductId !== null) {
      await tx
        .update(features)
        .set({ releaseId: null, updatedAt: new Date() })
        .where(
          and(
            eq(features.workspaceId, ws),
            eq(features.releaseId, id),
            ne(features.productId, targetProductId),
          ),
        );
    }
    const items = await tx
      .select({ n: count() })
      .from(features)
      .where(and(eq(features.workspaceId, ws), eq(features.releaseId, id)));
    if (emit) await ctx.writeOutbox(tx, scope!, emit);
    return toReleaseRecord(row, Number(items[0]?.n ?? 0));
  });
}

export async function deleteRelease(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx
      .select({ productId: releases.productId })
      .from(releases)
      .where(and(eq(releases.id, id), eq(releases.workspaceId, ws)))
      .limit(1);
    if (!current[0]) throw new ReleaseError(`Unknown release: ${id}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, current[0].productId)) {
      throw new ReleaseError(
        current[0].productId === null
          ? "Only the workspace owner can delete portfolio releases."
          : "Your role does not permit deleting releases for this product.",
      );
    }
    // features.release_id is ON DELETE SET NULL, so items are unscheduled.
    await tx
      .delete(releases)
      .where(and(eq(releases.id, id), eq(releases.workspaceId, ws)));
  });
}

function normalizeReleaseStatus(status: string | undefined): ReleaseStatus {
  if (status === undefined) return "planned";
  if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
    throw new ReleaseError(`Unknown release status: ${status}`);
  }
  return status as ReleaseStatus;
}

function toReleaseRecord(
  row: {
    id: string;
    name: string;
    productId: string | null;
    status: string;
    startDate: string | null;
    targetDate: string | null;
    shippedDate: string | null;
    notes: string | null;
    releaseNotesMode: string;
    releaseNotesBody: string | null;
    releaseNotesUrl: string | null;
    customFields: unknown;
  },
  itemCount: number,
): ReleaseRecord {
  return {
    id: row.id,
    name: row.name,
    productId: row.productId,
    status: row.status as ReleaseStatus,
    startDate: row.startDate,
    targetDate: row.targetDate,
    shippedDate: row.shippedDate,
    notes: row.notes,
    releaseNotesMode: row.releaseNotesMode as ReleaseNotesMode,
    releaseNotesBody: row.releaseNotesBody,
    releaseNotesUrl: row.releaseNotesUrl,
    customFields: toCustomFields(row.customFields),
    itemCount,
  };
}
