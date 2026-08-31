/**
 * Doc spaces and pages, in local file mode.
 *
 * Mirrors db/docs.ts, minus the half of it that is authorization: the db store
 * needs a two-step read-then-write check because a doc space is readable by
 * anyone who can see the product and editable only by someone who can write to
 * it. Local mode has one user, so what is left is the shape rule, that a page
 * cannot contain a page, which `assertLocalFolder` enforces on both the create
 * and the re-parent path.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";

import {
  type DocArea,
  DocError,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type WorkspaceScope,
  validateExternalDocUrl,
} from "../types";

import { type LocalStoreContext } from "./context";
import { localPath } from "./paths";

export async function getDocSpace(
  ctx: LocalStoreContext,
  productId: string,
  area: DocArea,
  _scope?: WorkspaceScope,
): Promise<DocSpace> {
  const rows = await ctx.readJsonFile<DocSpace>(
    localPath(ctx.root, "docSpaces"),
  );
  return (
    rows.find((r) => r.productId === productId && r.area === area) ?? {
      productId,
      area,
      mode: "unset",
      externalUrl: null,
      repoId: null,
    }
  );
}

export async function setDocSpace(
  ctx: LocalStoreContext,
  productId: string,
  area: DocArea,
  input: DocSpaceInput,
  _scope?: WorkspaceScope,
): Promise<DocSpace> {
  const externalUrl =
    input.mode === "external"
      ? validateExternalDocUrl(input.externalUrl)
      : null;
  if (input.mode === "github" && !input.repoId) {
    throw new DocError("Choose a repository.");
  }
  const next: DocSpace = {
    productId,
    area,
    mode: input.mode,
    externalUrl,
    repoId: input.mode === "github" ? (input.repoId ?? null) : null,
  };
  const rows = await ctx.readJsonFile<DocSpace>(
    localPath(ctx.root, "docSpaces"),
  );
  const rest = rows.filter(
    (r) => !(r.productId === productId && r.area === area),
  );
  await ctx.writeJsonFile(localPath(ctx.root, "docSpaces"), [...rest, next]);
  return next;
}

export async function listDocPages(
  ctx: LocalStoreContext,
  productId: string,
  area: DocArea,
  _scope?: WorkspaceScope,
): Promise<DocPageRecord[]> {
  const rows = await ctx.readJsonFile<DocPageRecord>(
    localPath(ctx.root, "docPages"),
  );
  return rows
    .filter((r) => r.productId === productId && r.area === area)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

export async function createDocPage(
  ctx: LocalStoreContext,
  input: DocPageInput,
  _scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  const title = input.title.trim();
  if (!title) throw new DocError("A title is required.");
  const rows = await ctx.readJsonFile<DocPageRecord>(
    localPath(ctx.root, "docPages"),
  );
  const parentId = input.parentId ?? null;
  if (parentId) assertLocalFolder(rows, parentId, input.productId, input.area);
  const siblings = rows.filter(
    (r) => r.productId === input.productId && r.area === input.area,
  );
  const now = new Date().toISOString();
  const page: DocPageRecord = {
    id: randomUUID(),
    productId: input.productId,
    area: input.area,
    parentId,
    kind: input.kind === "folder" ? "folder" : "page",
    title,
    content: input.content ?? "",
    position: siblings.length,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.writeJsonFile(localPath(ctx.root, "docPages"), [...rows, page]);
  return page;
}

export async function updateDocPage(
  ctx: LocalStoreContext,
  id: string,
  patch: DocPagePatch,
  _scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  const rows = await ctx.readJsonFile<DocPageRecord>(
    localPath(ctx.root, "docPages"),
  );
  const page = rows.find((r) => r.id === id);
  if (!page) throw new DocError(`Unknown page: ${id}`);
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new DocError("A title is required.");
    page.title = title;
  }
  if (patch.content !== undefined) {
    if (page.kind === "folder") throw new DocError("Folders have no content.");
    page.content = patch.content;
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === null) {
      page.parentId = null;
    } else {
      if (patch.parentId === id) {
        throw new DocError("A folder cannot contain itself.");
      }
      assertLocalFolder(rows, patch.parentId, page.productId, page.area);
      // Refuse moving a folder under its own descendant (cycle).
      let cursor: string | null = patch.parentId;
      while (cursor) {
        const anc = rows.find((r) => r.id === cursor);
        const next: string | null = anc?.parentId ?? null;
        if (next === id)
          throw new DocError("A folder cannot move inside itself.");
        cursor = next;
      }
      page.parentId = patch.parentId;
    }
  }
  page.updatedAt = new Date().toISOString();
  await ctx.writeJsonFile(localPath(ctx.root, "docPages"), rows);
  return page;
}

export async function deleteDocPage(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await ctx.readJsonFile<DocPageRecord>(
    localPath(ctx.root, "docPages"),
  );
  if (!rows.some((r) => r.id === id)) throw new DocError(`Unknown page: ${id}`);
  // Remove the row and everything beneath it (folders cascade).
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && doomed.has(r.parentId) && !doomed.has(r.id)) {
        doomed.add(r.id);
        grew = true;
      }
    }
  }
  await ctx.writeJsonFile(
    localPath(ctx.root, "docPages"),
    rows.filter((r) => !doomed.has(r.id)),
  );
}

function assertLocalFolder(
  rows: DocPageRecord[],
  folderId: string,
  productId: string,
  area: DocArea,
): void {
  const folder = rows.find(
    (r) => r.id === folderId && r.productId === productId && r.area === area,
  );
  if (!folder) throw new DocError("Unknown folder.");
  if (folder.kind !== "folder")
    throw new DocError("Pages cannot contain pages.");
}
