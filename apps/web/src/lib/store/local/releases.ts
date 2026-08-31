/**
 * Releases, in local file mode.
 *
 * Mirrors db/releases.ts: the same stored `status`, the same `shipped_date`
 * stamped on the way in and cleared on the way out, the same unscheduling of
 * items when a release moves product or is deleted. The authorization is what
 * falls away, because local mode has one user who owns everything.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { todayDateOnly } from "@specboards/core";

import {
  type CustomFieldValue,
  type OutboxEmit,
  RELEASE_STATUSES,
  ReleaseError,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type WorkspaceScope,
  compareReleases,
} from "../types";

import { type LocalStoreContext } from "./context";
import { localPath } from "./paths";

export async function listReleases(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<ReleaseRecord[]> {
  const [rows, all] = await Promise.all([readReleases(ctx), ctx.loadAll()]);
  const counts = new Map<string, number>();
  for (const f of all) {
    if (f.releaseId)
      counts.set(f.releaseId, (counts.get(f.releaseId) ?? 0) + 1);
  }
  return rows
    .map((r) => ({
      ...r,
      productId: r.productId ?? null,
      shippedDate: r.shippedDate ?? null,
      notes: r.notes ?? null,
      releaseNotesMode: r.releaseNotesMode ?? "none",
      releaseNotesBody: r.releaseNotesBody ?? null,
      releaseNotesUrl: r.releaseNotesUrl ?? null,
      customFields: r.customFields ?? {},
      itemCount: counts.get(r.id) ?? 0,
    }))
    .sort(compareReleases);
}

export async function createRelease(
  ctx: LocalStoreContext,
  input: ReleaseInput,
  _scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const name = input.name.trim();
  if (!name) throw new ReleaseError("Release name is required.");
  const productId = input.productId ?? null;
  const rows = await readReleases(ctx);
  // Names are unique within a product (and within the portfolio scope).
  if (
    rows.some((r) => r.name === name && (r.productId ?? null) === productId)
  ) {
    throw new ReleaseError(`A release named "${name}" already exists.`);
  }
  const status = input.status ?? "planned";
  if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
    throw new ReleaseError(`Unknown release status: ${status}`);
  }
  const release: LocalRelease = {
    id: randomUUID(),
    name,
    productId,
    status,
    startDate: input.startDate ?? null,
    targetDate: input.targetDate ?? null,
    // Stamped on create as well as on transition: the date describes the
    // shipped state, so a release created already shipped has one. See
    // db/releases.ts, which had the same gap.
    shippedDate: status === "shipped" ? todayDateOnly() : null,
    notes: input.notes ?? null,
    releaseNotesMode: input.releaseNotesMode ?? "none",
    releaseNotesBody: input.releaseNotesBody ?? null,
    releaseNotesUrl: input.releaseNotesUrl ?? null,
    customFields: input.customFields ?? {},
  };
  await writeReleases(ctx, [...rows, release]);
  return {
    ...release,
    productId,
    shippedDate: release.shippedDate ?? null,
    notes: release.notes ?? null,
    releaseNotesMode: release.releaseNotesMode ?? "none",
    releaseNotesBody: release.releaseNotesBody ?? null,
    releaseNotesUrl: release.releaseNotesUrl ?? null,
    customFields: release.customFields ?? {},
    itemCount: 0,
  };
}

export async function updateRelease(
  ctx: LocalStoreContext,
  id: string,
  patch: ReleasePatch,
  _scope?: WorkspaceScope,
  _emit?: OutboxEmit, // webhooks are DB-only; ignored in local file mode
): Promise<ReleaseRecord> {
  const rows = await readReleases(ctx);
  const release = rows.find((r) => r.id === id);
  if (!release) throw new ReleaseError(`Unknown release: ${id}`);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ReleaseError("Release name is required.");
    release.name = name;
  }
  if (patch.status !== undefined) {
    if (!(RELEASE_STATUSES as readonly string[]).includes(patch.status)) {
      throw new ReleaseError(`Unknown release status: ${patch.status}`);
    }
    const prevStatus = release.status;
    release.status = patch.status;
    // Stamp the actual ship date on first ship; clear it on reopen. Planned
    // dates are retained.
    if (patch.status === "shipped" && prevStatus !== "shipped") {
      if (!release.shippedDate) {
        release.shippedDate = todayDateOnly();
      }
    } else if (patch.status !== "shipped" && prevStatus === "shipped") {
      release.shippedDate = null;
    }
  }
  if (patch.startDate !== undefined) release.startDate = patch.startDate;
  if (patch.targetDate !== undefined) release.targetDate = patch.targetDate;
  if (patch.notes !== undefined) release.notes = patch.notes;
  if (patch.releaseNotesMode !== undefined)
    release.releaseNotesMode = patch.releaseNotesMode;
  if (patch.releaseNotesBody !== undefined)
    release.releaseNotesBody = patch.releaseNotesBody;
  if (patch.releaseNotesUrl !== undefined)
    release.releaseNotesUrl = patch.releaseNotesUrl;
  if (patch.customFields !== undefined)
    release.customFields = patch.customFields;
  if (patch.productId !== undefined) {
    const targetProductId = patch.productId;
    if (
      rows.some(
        (r) =>
          r.id !== id &&
          r.name === release.name &&
          (r.productId ?? null) === targetProductId,
      )
    ) {
      throw new ReleaseError(
        `A release named "${release.name}" already exists.`,
      );
    }
    release.productId = targetProductId;
  }
  await writeReleases(ctx, rows);
  const all = await ctx.loadAll();
  return {
    ...release,
    productId: release.productId ?? null,
    shippedDate: release.shippedDate ?? null,
    notes: release.notes ?? null,
    releaseNotesMode: release.releaseNotesMode ?? "none",
    releaseNotesBody: release.releaseNotesBody ?? null,
    releaseNotesUrl: release.releaseNotesUrl ?? null,
    customFields: release.customFields ?? {},
    itemCount: all.filter((f) => f.releaseId === id).length,
  };
}

export async function deleteRelease(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readReleases(ctx);
  if (!rows.some((r) => r.id === id))
    throw new ReleaseError(`Unknown release: ${id}`);
  await writeReleases(
    ctx,
    rows.filter((r) => r.id !== id),
  );
  // Unschedule the deleted release's items (mirrors the DB's SET NULL).
  const items = await ctx.readItems();
  let itemsChanged = false;
  for (const item of items) {
    if (item.releaseId === id) {
      item.releaseId = null;
      itemsChanged = true;
    }
  }
  if (itemsChanged) await ctx.writeItems(items);
  const meta = await ctx.readMetadata();
  let metaChanged = false;
  for (const m of Object.values(meta)) {
    if (m.releaseId === id) {
      m.releaseId = null;
      metaChanged = true;
    }
  }
  if (metaChanged) await ctx.writeMetadata(meta);
}

/**
 * The persisted release rows.
 *
 * Exported, unlike this module's other helper, because `createFeature` has to
 * check that a release exists and is reachable from the item's product before
 * scheduling into it. That is the items domain asking a release question, and
 * one exported reader is a smaller seam than teaching the context about
 * releases.
 */
export async function readReleases(
  ctx: LocalStoreContext,
): Promise<LocalRelease[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "releases"), "utf8"),
    ) as LocalRelease[];
  } catch {
    return [];
  }
}

async function writeReleases(
  ctx: LocalStoreContext,
  rows: LocalRelease[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "releases")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "releases"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

/** A release persisted in local file mode. */
interface LocalRelease {
  id: string;
  name: string;
  /** Product this release belongs to, or null for a portfolio release. */
  productId?: string | null;
  status: "planned" | "in_progress" | "shipped";
  startDate: string | null;
  targetDate: string | null;
  /** Actual ship date (YYYY-MM-DD), stamped on ship and cleared on reopen. */
  shippedDate?: string | null;
  notes?: string | null;
  /** Customer-facing release-notes mode (default none when absent). */
  releaseNotesMode?: "none" | "in_app" | "external";
  releaseNotesBody?: string | null;
  releaseNotesUrl?: string | null;
  /** Release-scoped custom-property values (default empty when absent). */
  customFields?: Record<string, CustomFieldValue>;
}
