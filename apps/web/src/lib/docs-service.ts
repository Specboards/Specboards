import { getStore } from "@/lib/store";
import {
  DocError,
  isDocArea,
  type DocArea,
  type DocPageInput,
  type DocPagePatch,
  type DocPageRecord,
  type DocSpace,
  type DocSpaceInput,
  type WorkspaceScope,
} from "@/lib/store/types";

/**
 * The docs layer behind the Plan-section areas (Strategy / Research /
 * Architecture): parse-and-validate helpers for the API routes plus thin
 * wrappers over the store. Mirrors features-service.
 */

export function parseDocArea(v: unknown): DocArea {
  if (!isDocArea(v)) throw new DocError(`Unknown doc area: ${String(v)}`);
  return v;
}

function parseProductId(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new DocError("A product is required.");
  }
  return v;
}

export function parseDocSpaceInput(body: unknown): {
  productId: string;
  area: DocArea;
  input: DocSpaceInput;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const mode = b.mode;
  if (mode !== "local" && mode !== "external" && mode !== "github") {
    throw new DocError(`Unknown doc source mode: ${String(mode)}`);
  }
  return {
    productId: parseProductId(b.productId),
    area: parseDocArea(b.area),
    input: {
      mode,
      externalUrl: typeof b.externalUrl === "string" ? b.externalUrl : null,
      repoId: typeof b.repoId === "string" ? b.repoId : null,
    },
  };
}

export function parseDocPageInput(body: unknown): DocPageInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title !== "string") throw new DocError("A title is required.");
  if (b.kind !== undefined && b.kind !== "page" && b.kind !== "folder") {
    throw new DocError(`Unknown page kind: ${String(b.kind)}`);
  }
  if (b.parentId !== undefined && b.parentId !== null && typeof b.parentId !== "string") {
    throw new DocError("Invalid folder.");
  }
  if (b.content !== undefined && typeof b.content !== "string") {
    throw new DocError("Invalid content.");
  }
  return {
    productId: parseProductId(b.productId),
    area: parseDocArea(b.area),
    parentId: (b.parentId as string | null | undefined) ?? null,
    kind: b.kind as "page" | "folder" | undefined,
    title: b.title,
    content: b.content as string | undefined,
  };
}

export function parseDocPagePatch(body: unknown): DocPagePatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: DocPagePatch = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") throw new DocError("Invalid title.");
    patch.title = b.title;
  }
  if (b.content !== undefined) {
    if (typeof b.content !== "string") throw new DocError("Invalid content.");
    patch.content = b.content;
  }
  if (b.parentId !== undefined) {
    if (b.parentId !== null && typeof b.parentId !== "string") {
      throw new DocError("Invalid folder.");
    }
    patch.parentId = b.parentId;
  }
  if (Object.keys(patch).length === 0) {
    throw new DocError("Nothing to update.");
  }
  return patch;
}

export async function getDocSpace(
  productId: string,
  area: DocArea,
  scope?: WorkspaceScope,
): Promise<DocSpace> {
  const store = await getStore();
  return store.getDocSpace(productId, area, scope);
}

export async function setDocSpace(
  productId: string,
  area: DocArea,
  input: DocSpaceInput,
  scope?: WorkspaceScope,
): Promise<DocSpace> {
  const store = await getStore();
  return store.setDocSpace(productId, area, input, scope);
}

export async function listDocPages(
  productId: string,
  area: DocArea,
  scope?: WorkspaceScope,
): Promise<DocPageRecord[]> {
  const store = await getStore();
  return store.listDocPages(productId, area, scope);
}

export async function createDocPage(
  input: DocPageInput,
  scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  const store = await getStore();
  return store.createDocPage(input, scope);
}

export async function updateDocPage(
  id: string,
  patch: DocPagePatch,
  scope?: WorkspaceScope,
): Promise<DocPageRecord> {
  const store = await getStore();
  return store.updateDocPage(id, patch, scope);
}

export async function deleteDocPage(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  return store.deleteDocPage(id, scope);
}
