/**
 * Saved views and board preferences, in local file mode.
 *
 * The same domain as db/views.ts and the same shape of data, kept in two JSON
 * files instead of two tables. What is different is what is missing: there is
 * no user to scope by, because local mode has exactly one. The db store's
 * `(workspaceId, userId)` key is the whole of its access check; here there is
 * nobody to check against, so a saved view is simply a row in a file.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type BoardKey,
  type BoardPreferences,
  type SavedView,
  type SavedViewInput,
  type SavedViewPatch,
  type WorkspaceScope,
} from "../types";

import { type LocalStoreContext } from "./context";
import { localPath } from "./paths";

export async function listSavedViews(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<SavedView[]> {
  return readViews(ctx);
}

export async function createSavedView(
  ctx: LocalStoreContext,
  input: SavedViewInput,
  _scope?: WorkspaceScope,
): Promise<SavedView> {
  const views = await readViews(ctx);
  const view: SavedView = {
    id: randomUUID(),
    name: input.name,
    view: input.view,
    filters: input.filters,
  };
  await writeViews(ctx, [view, ...views]); // newest first, matching db order
  return view;
}

export async function updateSavedView(
  ctx: LocalStoreContext,
  id: string,
  patch: SavedViewPatch,
  _scope?: WorkspaceScope,
): Promise<SavedView | null> {
  const views = await readViews(ctx);
  const existing = views.find((v) => v.id === id);
  if (!existing) return null;
  const updated: SavedView = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.filters !== undefined ? { filters: patch.filters } : {}),
  };
  await writeViews(
    ctx,
    views.map((v) => (v.id === id ? updated : v)),
  );
  return updated;
}

export async function deleteSavedView(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const views = await readViews(ctx);
  await writeViews(
    ctx,
    views.filter((v) => v.id !== id),
  );
}

export async function getBoardPreferences(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
  board: BoardKey = "backlog",
): Promise<BoardPreferences | null> {
  const map = await readBoardPrefsMap(ctx);
  return map[board] ?? null;
}

export async function setBoardPreferences(
  ctx: LocalStoreContext,
  prefs: BoardPreferences,
  _scope?: WorkspaceScope,
  board: BoardKey = "backlog",
): Promise<void> {
  const map = await readBoardPrefsMap(ctx);
  map[board] = prefs;
  await fs.mkdir(path.dirname(localPath(ctx.root, "boardPrefs")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "boardPrefs"),
    JSON.stringify(map, null, 2) + "\n",
    "utf8",
  );
}

// Saved views persist to `.specboards/local-views.json`. There's a single
// implicit user in local mode, so no per-user scoping.
async function readViews(ctx: LocalStoreContext): Promise<SavedView[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "views"), "utf8"),
    ) as SavedView[];
  } catch {
    return [];
  }
}

async function writeViews(
  ctx: LocalStoreContext,
  views: SavedView[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "views")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "views"),
    JSON.stringify(views, null, 2) + "\n",
    "utf8",
  );
}

// Board preferences persist to `.specboards/local-board-prefs.json` as a map
// keyed by board ("backlog"/"roadmap"). Single implicit user in local mode,
// so no per-user scoping. A legacy flat file (pre per-board prefs) is read as
// the Backlog's prefs and rewritten into the map on the next save.
async function readBoardPrefsMap(
  ctx: LocalStoreContext,
): Promise<Partial<Record<BoardKey, BoardPreferences>>> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(localPath(ctx.root, "boardPrefs"), "utf8"),
    ) as BoardPreferences | Partial<Record<BoardKey, BoardPreferences>>;
    if (parsed && ("cardFields" in parsed || "featured" in parsed)) {
      return { backlog: parsed as BoardPreferences };
    }
    return (parsed ?? {}) as Partial<Record<BoardKey, BoardPreferences>>;
  } catch {
    return {};
  }
}
