"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  FeatureRecord,
  IdeaInput,
  IdeaPatch,
  IdeaRecord,
  IdeaSettings,
  IdeaSettingsPatch,
  IdeaStage,
  StatusStageInput,
} from "@/lib/store/types";

/** Capture a new idea; returns the new record. */
export async function createIdea(input: IdeaInput): Promise<IdeaRecord> {
  const res = await apiFetch("/api/v1/ideas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Create idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Update an idea's title/description/status/product; returns the record. */
export async function updateIdea(
  id: string,
  patch: IdeaPatch,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Update idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Delete an idea. */
export async function deleteIdea(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete idea failed with ${res.status}`);
  }
}

/** Set the caller's vote on an idea; returns the updated record. */
export async function setIdeaVote(
  id: string,
  voted: boolean,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voted }),
  });
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Vote failed with ${res.status}`);
  }
  return body.idea;
}

/** Promote an idea into a feature; returns both records. */
export async function promoteIdea(
  id: string,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const res = await apiFetch(
    `/api/v1/ideas/${encodeURIComponent(id)}/promote`,
    {
      method: "POST",
    },
  );
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea || !body?.feature) {
    throw new Error(body?.error ?? `Promote failed with ${res.status}`);
  }
  return { idea: body.idea, feature: body.feature };
}

/** Replace the workspace's idea review stages (admin-only); returns the set. */
export async function updateIdeaStatuses(
  stages: StatusStageInput[],
): Promise<IdeaStage[]> {
  const res = await apiFetch("/api/v1/idea-statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages }),
  });
  const body = (await res.json().catch(() => null)) as {
    statuses?: IdeaStage[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(
      body?.error ?? `Update idea stages failed with ${res.status}`,
    );
  }
  return body.statuses;
}

/** Update the workspace's Ideas configuration (admin-only); returns it. */
export async function updateIdeaSettings(
  patch: IdeaSettingsPatch,
): Promise<IdeaSettings> {
  const res = await apiFetch("/api/v1/idea-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    settings?: IdeaSettings;
    error?: string;
  } | null;
  if (!res.ok || !body?.settings) {
    throw new Error(
      body?.error ?? `Update Ideas settings failed with ${res.status}`,
    );
  }
  return body.settings;
}
