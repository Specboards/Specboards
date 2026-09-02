"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  BoardKey,
  BoardPreferences,
  PropertyDef,
  PropertyInput,
  PropertyPatch,
  SavedView,
  SavedViewInput,
} from "@/lib/store/types";

/** Define a custom property (admin-only on the server); returns it. */
export async function createProperty(
  input: PropertyInput,
  productId?: string | null,
): Promise<PropertyDef> {
  const res = await apiFetch("/api/v1/properties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Create property failed with ${res.status}`);
  }
  return body.property;
}

/** Update a custom property (admin-only); returns the updated definition. */
export async function updateProperty(
  id: string,
  patch: PropertyPatch,
): Promise<PropertyDef> {
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Update property failed with ${res.status}`);
  }
  return body.property;
}

/** Delete a custom property definition (admin-only). */
export async function deleteProperty(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete property failed with ${res.status}`);
  }
}

/** Persist the acting user's board display preferences for a space. */
export async function saveBoardPreferences(
  prefs: BoardPreferences,
  board: BoardKey = "backlog",
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/board-preferences?board=${encodeURIComponent(board)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Save preferences failed with ${res.status}`,
    );
  }
}

/** Save the current backlog filters as a named view. */
export async function saveView(input: SavedViewInput): Promise<SavedView> {
  const res = await apiFetch("/api/v1/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    view?: SavedView;
    error?: string;
  } | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Save view failed with ${res.status}`);
  }
  return body.view;
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete view failed with ${res.status}`);
  }
}
