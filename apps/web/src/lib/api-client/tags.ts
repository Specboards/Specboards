"use client";

import type { TagDef, TagImportPlan } from "@specboards/core";

import { apiFetch } from "@/lib/api-client/request";

/** Add a tag to the registry. Any member who can write may do this. */
export async function createTag(name: string): Promise<TagDef> {
  const res = await apiFetch("/api/v1/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => null)) as {
    tag?: TagDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.tag) {
    throw new Error(body?.error ?? `Create tag failed with ${res.status}`);
  }
  return body.tag;
}

/** Rename a tag, rewriting it on every item that carries it. Admin-only. */
export async function renameTag(id: string, name: string): Promise<TagDef> {
  const res = await apiFetch(`/api/v1/tags/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => null)) as {
    tag?: TagDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.tag) {
    throw new Error(body?.error ?? `Rename tag failed with ${res.status}`);
  }
  return body.tag;
}

/**
 * Delete a tag and take it off every item that carried it. Admin-only.
 * Resolves with the number of items changed.
 */
export async function deleteTag(id: string): Promise<number> {
  const res = await apiFetch(`/api/v1/tags/${id}`, { method: "DELETE" });
  const body = (await res.json().catch(() => null)) as {
    itemCount?: number;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Delete tag failed with ${res.status}`);
  }
  return body?.itemCount ?? 0;
}

/** What a bulk delete did, per tag id. Inferred at the call site. */
interface TagBulkResult {
  okCount: number;
  failCount: number;
  results: { id: string; ok: boolean; itemCount?: number; error?: string }[];
}

/**
 * Delete several tags at once. Admin-only. Each comes off every item that
 * carried it, exactly as the single delete does.
 */
export async function deleteTags(ids: string[]): Promise<TagBulkResult> {
  const res = await apiFetch("/api/v1/tags/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const body = (await res.json().catch(() => null)) as
    | (TagBulkResult & { error?: string })
    | null;
  if (!res.ok || !body?.results) {
    throw new Error(body?.error ?? `Delete tags failed with ${res.status}`);
  }
  return body;
}

/** A previewed or applied CSV import. `applied` is null on a preview. */
interface TagImportResponse {
  plan: TagImportPlan;
  applied: { line: number; ok: boolean; error?: string }[] | null;
}

/**
 * Plan a CSV against the registry, and run it when `apply` is set.
 *
 * The plan is always recomputed on the server, so calling this twice (preview,
 * then apply) is not sending a stale decision back: the second call measures
 * the file against whatever the registry looks like at that moment.
 */
export async function importTags(
  csv: string,
  apply: boolean,
): Promise<TagImportResponse> {
  const res = await apiFetch("/api/v1/tags/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv, apply }),
  });
  const body = (await res.json().catch(() => null)) as
    | (TagImportResponse & { error?: string })
    | null;
  if (!res.ok || !body?.plan) {
    throw new Error(body?.error ?? `Tag import failed with ${res.status}`);
  }
  return body;
}
