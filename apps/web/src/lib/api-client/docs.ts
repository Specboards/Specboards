"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  DocArea,
  DocPageInput,
  DocPagePatch,
  DocPageRecord,
  DocSpace,
} from "@/lib/store/types";

/** Choose (or change) where a Plan-section area's docs live. */
export async function setDocSpace(input: {
  productId: string;
  area: DocArea;
  mode: "local" | "external" | "github";
  externalUrl?: string | null;
  repoId?: string | null;
}): Promise<DocSpace> {
  const res = await apiFetch("/api/v1/doc-spaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    error?: string;
  } | null;
  if (!res.ok || !body?.space) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.space;
}

/** Create a doc folder or page; returns the new record. */
export async function createDocPage(
  input: DocPageInput,
): Promise<DocPageRecord> {
  const res = await apiFetch("/api/v1/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.page;
}

/** Rename, edit, or move a doc page; returns the updated record. */
export async function patchDocPage(
  id: string,
  patch: DocPagePatch,
): Promise<DocPageRecord> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.page;
}

/** Delete a doc page, or a folder and its contents. */
export async function deleteDocPage(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}

/**
 * Create a private GitHub docs repository and bind it as the area's doc
 * source. Returns the updated space plus the created repo's coordinates.
 */
export async function createGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  name: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Connect a repository the GitHub App installation can already access as the
 * area's doc source.
 */
export async function connectGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  owner: string;
  name: string;
  installationId: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: input.productId,
      area: input.area,
      installationId: input.installationId,
      existing: { owner: input.owner, name: input.name },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Save (commit) one Markdown file in a GitHub-backed doc area. `blobSha` is
 * the sha the file had when loaded (null for a new page); a stale sha means
 * someone else changed the file and the save is rejected. Returns the new sha
 * for the next save.
 */
export async function saveGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  content: string;
  blobSha: string | null;
}): Promise<{ blobSha: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    blobSha?: string;
    error?: string;
  } | null;
  if (!res.ok || typeof body?.blobSha !== "string") {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return { blobSha: body.blobSha };
}

/** Rename (or move) one Markdown file in a GitHub-backed doc area. */
export async function renameGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  toPath: string;
}): Promise<{ path: string; blobSha: string; content: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    blobSha?: string;
    content?: string;
    error?: string;
  } | null;
  if (
    !res.ok ||
    typeof body?.path !== "string" ||
    typeof body.blobSha !== "string" ||
    typeof body.content !== "string"
  ) {
    throw new Error(body?.error ?? `Rename failed with ${res.status}`);
  }
  return { path: body.path, blobSha: body.blobSha, content: body.content };
}

/** Delete one Markdown file in a GitHub-backed doc area (one commit). */
export async function deleteGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  blobSha: string;
}): Promise<void> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}
