"use client";

import { apiFetch } from "@/lib/api-client/request";
import type { ItemDetailData } from "@/lib/item-detail";
import type {
  CommentInput,
  CommentRecord,
  CreatableRelationDirection,
  CreateFeatureInput,
  FeaturePatch,
  FeatureRecord,
  FeatureRelation,
  GithubLink,
  GithubLinkInput,
  ItemEvent,
} from "@/lib/store/types";

/**
 * Load the full item-detail bundle (metadata + properties + hierarchy +
 * candidates + edit rights) the flyout renders. Mirrors what the full item page
 * assembles server-side, so both views show the same content.
 */
export async function getItemDetail(specId: string): Promise<ItemDetailData> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/context`,
  );
  const body = (await res.json().catch(() => null)) as {
    data?: ItemDetailData;
    error?: string;
  } | null;
  if (!res.ok || !body?.data) {
    throw new Error(body?.error ?? `Failed to load item (${res.status}).`);
  }
  return body.data;
}

export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
): Promise<void> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `PATCH failed with ${res.status}`);
  }
}

/** One item's outcome in a bulk edit (mirrors the server's BulkPatchItemResult). */
interface BulkPatchItemResult {
  specId: string;
  ok: boolean;
  error?: string;
}

interface BulkPatchResult {
  results: BulkPatchItemResult[];
  okCount: number;
  failCount: number;
}

/** Tag mutations for a bulk edit (merged per item, not a wholesale replace). */
export interface BulkTagOps {
  addTags?: string[];
  clearTags?: boolean;
}

/**
 * Apply one change to many items via `PATCH /api/v1/features/bulk`. The direct
 * patch accepts status / assigneeId / releaseId; tags are added or cleared via
 * `tagOps` so a mixed selection isn't overwritten. Resolves with the per-item
 * result (some may have failed); rejects only on auth or a request the server
 * rejected outright.
 */
export async function bulkPatchFeatures(
  specIds: string[],
  patch: Pick<FeaturePatch, "status" | "assigneeId" | "releaseId">,
  tagOps: BulkTagOps = {},
): Promise<BulkPatchResult> {
  const res = await apiFetch(`/api/v1/features/bulk`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specIds, patch, ...tagOps }),
  });
  const body = (await res.json().catch(() => null)) as
    (BulkPatchResult & { error?: string }) | null;
  if (!res.ok || !body || !Array.isArray(body.results)) {
    throw new Error(body?.error ?? `Bulk edit failed with ${res.status}`);
  }
  return body;
}

/** List a feature's comments (oldest first). */
export async function listComments(specId: string): Promise<CommentRecord[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/comments`,
  );
  const body = (await res.json().catch(() => null)) as {
    comments?: CommentRecord[];
    error?: string;
  } | null;
  if (!res.ok || !body?.comments) {
    throw new Error(body?.error ?? `Failed to load comments (${res.status}).`);
  }
  return body.comments;
}

/** An item's change history, newest first. */
export async function listItemEvents(specId: string): Promise<ItemEvent[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/events`,
  );
  const body = (await res.json().catch(() => null)) as {
    events?: ItemEvent[];
    error?: string;
  } | null;
  if (!res.ok || !body?.events) {
    throw new Error(body?.error ?? `Failed to load history (${res.status}).`);
  }
  return body.events;
}

/** Post a comment to a feature; returns the created record. */
export async function createComment(
  specId: string,
  input: CommentInput,
): Promise<CommentRecord> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    comment?: CommentRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.comment) {
    throw new Error(body?.error ?? `Failed to post comment (${res.status}).`);
  }
  return body.comment;
}

/** Delete a comment (author or workspace owner only). */
export async function deleteComment(commentId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Failed to delete comment (${res.status}).`);
  }
}

/** Create a DB-native work item (initiative/epic); returns the new record. */
export async function createWorkItem(
  input: CreateFeatureInput,
): Promise<FeatureRecord> {
  const res = await apiFetch("/api/v1/features", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.feature;
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(
  specId: string,
  opts: { removeSpec?: boolean } = {},
): Promise<void> {
  // removeSpec also deletes the item's spec file from git; required for an item
  // that has one, since a surviving file is re-imported by the next sync.
  const query = opts.removeSpec ? "?removeSpec=1" : "";
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}${query}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `DELETE failed with ${res.status}`);
  }
}

/** Create a typed relation from a feature; returns its refreshed relations. */
export async function addRelation(
  specId: string,
  input: { toSpecId: string; direction: CreatableRelationDirection },
): Promise<FeatureRelation[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Remove a relation by id; returns the feature's refreshed relations. */
export async function removeRelation(
  specId: string,
  linkId: string,
): Promise<FeatureRelation[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Remove relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Link a GitHub artifact to a feature; returns its refreshed links. */
export async function addGithubLink(
  specId: string,
  input: GithubLinkInput,
): Promise<GithubLink[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add GitHub link failed with ${res.status}`);
  }
  return body?.githubLinks ?? [];
}

/** Remove a GitHub link by id; returns the feature's refreshed links. */
export async function removeGithubLink(
  specId: string,
  linkId: string,
): Promise<GithubLink[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Remove GitHub link failed with ${res.status}`,
    );
  }
  return body?.githubLinks ?? [];
}
