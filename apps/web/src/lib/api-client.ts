"use client";

import type { FeaturePatch } from "@/lib/store/types";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

/** Thrown when a write is rejected for lack of a session (HTTP 401). */
export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthRequiredError";
  }
}

export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
): Promise<void> {
  const res = await fetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `PATCH failed with ${res.status}`);
  }
}

/**
 * Create the organization (first user only). `seedSampleData` populates a
 * starter board; otherwise the workspace begins empty. Returns the workspace slug.
 */
export async function createWorkspace(
  name: string,
  seedSampleData: boolean,
): Promise<{ slug: string }> {
  const res = await fetch("/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, seedSampleData }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { workspace?: { slug: string }; error?: string }
    | null;
  if (!res.ok || !body?.workspace) {
    throw new Error(body?.error ?? `Workspace creation failed with ${res.status}`);
  }
  return body.workspace;
}
