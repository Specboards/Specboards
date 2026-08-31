/**
 * Saved views and board preferences: what one user has chosen to see.
 *
 * The odd one out among the domains. Everything here is keyed by
 * `(workspaceId, userId)` and never consults `ProductAccess`, because a saved
 * view is a personal bookmark rather than shared workspace data: there is no
 * one else's row to be authorized against. The scope's user id in the `where`
 * clause is the whole access check, and it is why these methods take no
 * product id.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import { and, boardPreferences, desc, eq, savedViews } from "@specboards/db";

import type {
  BoardKey,
  BoardPreferences,
  SavedView,
  SavedViewFilters,
  SavedViewInput,
  SavedViewPatch,
  WorkspaceScope,
} from "../types";

import { type DbStoreContext } from "./context";

export async function listSavedViews(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<SavedView[]> {
  return ctx.scoped(scope, async (tx) => {
    const rows = await tx
      .select({
        id: savedViews.id,
        name: savedViews.name,
        view: savedViews.view,
        filters: savedViews.filters,
      })
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, scope!.workspaceId),
          eq(savedViews.userId, scope!.userId),
        ),
      )
      .orderBy(desc(savedViews.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      view: r.view,
      filters: toSavedViewFilters(r.filters),
    }));
  });
}

export async function createSavedView(
  ctx: DbStoreContext,
  input: SavedViewInput,
  scope?: WorkspaceScope,
): Promise<SavedView> {
  return ctx.scoped(scope, async (tx) => {
    const [row] = await tx
      .insert(savedViews)
      .values({
        workspaceId: scope!.workspaceId,
        userId: scope!.userId,
        name: input.name,
        view: input.view,
        filters: input.filters,
      })
      .returning({
        id: savedViews.id,
        name: savedViews.name,
        view: savedViews.view,
        filters: savedViews.filters,
      });
    if (!row) throw new Error("Failed to create saved view.");
    return {
      id: row.id,
      name: row.name,
      view: row.view,
      filters: toSavedViewFilters(row.filters),
    };
  });
}

export async function updateSavedView(
  ctx: DbStoreContext,
  id: string,
  patch: SavedViewPatch,
  scope?: WorkspaceScope,
): Promise<SavedView | null> {
  return ctx.scoped(scope, async (tx) => {
    const set: Partial<typeof savedViews.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.filters !== undefined) set.filters = patch.filters;
    // Nothing to change: return the current row (or null if not owned).
    if (Object.keys(set).length === 0) {
      const [current] = await tx
        .select({
          id: savedViews.id,
          name: savedViews.name,
          view: savedViews.view,
          filters: savedViews.filters,
        })
        .from(savedViews)
        .where(
          and(
            eq(savedViews.id, id),
            eq(savedViews.workspaceId, scope!.workspaceId),
            eq(savedViews.userId, scope!.userId),
          ),
        );
      return current
        ? { ...current, filters: toSavedViewFilters(current.filters) }
        : null;
    }
    const [row] = await tx
      .update(savedViews)
      .set(set)
      .where(
        and(
          eq(savedViews.id, id),
          eq(savedViews.workspaceId, scope!.workspaceId),
          eq(savedViews.userId, scope!.userId),
        ),
      )
      .returning({
        id: savedViews.id,
        name: savedViews.name,
        view: savedViews.view,
        filters: savedViews.filters,
      });
    return row ? { ...row, filters: toSavedViewFilters(row.filters) } : null;
  });
}

export async function deleteSavedView(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.id, id),
          eq(savedViews.workspaceId, scope!.workspaceId),
          eq(savedViews.userId, scope!.userId),
        ),
      );
  });
}

export async function getBoardPreferences(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  board: BoardKey = "backlog",
): Promise<BoardPreferences | null> {
  return ctx.scoped(scope, async (tx) => {
    const row = await tx.query.boardPreferences.findFirst({
      where: and(
        eq(boardPreferences.workspaceId, scope!.workspaceId),
        eq(boardPreferences.userId, scope!.userId),
        eq(boardPreferences.board, board),
      ),
    });
    if (!row) return null;
    return {
      cardFields: Array.isArray(row.cardFields)
        ? (row.cardFields as string[])
        : null,
      featured: row.featured,
    };
  });
}

export async function setBoardPreferences(
  ctx: DbStoreContext,
  prefs: BoardPreferences,
  scope?: WorkspaceScope,
  board: BoardKey = "backlog",
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .insert(boardPreferences)
      .values({
        workspaceId: scope!.workspaceId,
        userId: scope!.userId,
        board,
        cardFields: prefs.cardFields ?? [],
        featured: prefs.featured,
      })
      .onConflictDoUpdate({
        target: [
          boardPreferences.workspaceId,
          boardPreferences.userId,
          boardPreferences.board,
        ],
        set: {
          cardFields: prefs.cardFields ?? [],
          featured: prefs.featured,
          updatedAt: new Date(),
        },
      });
  });
}

/** Normalize the jsonb filters column into the typed filter bundle. */
function toSavedViewFilters(value: unknown): SavedViewFilters {
  const out: SavedViewFilters = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") out[k] = v;
    }
  }
  return out;
}
