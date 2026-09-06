"use client";

import type { TagDef } from "@specboards/core";

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

/** Drop a tag definition. Item values are left in place. Admin-only. */
export async function deleteTag(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/tags/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete tag failed with ${res.status}`);
  }
}
