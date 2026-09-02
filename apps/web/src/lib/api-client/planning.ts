"use client";

import { apiFetch } from "@/lib/api-client/request";
import type { ReleaseItemGroup } from "@/lib/release-items";
import type {
  CycleGenerateInput,
  CycleInput,
  CyclePatch,
  CycleRecord,
  GoalContribution,
  GoalInput,
  GoalPatch,
  GoalRecord,
  KeyResultCreateBody,
  KeyResultPatch,
  ReleaseInput,
  ReleasePatch,
  ReleaseRecord,
} from "@/lib/store/types";

/** Create a release (admin-only on the server); returns the new record. */
export async function createRelease(
  input: ReleaseInput,
): Promise<ReleaseRecord> {
  const res = await apiFetch("/api/v1/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Create release failed with ${res.status}`);
  }
  return body.release;
}

/** Update a release (admin-only); returns the updated record. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
): Promise<ReleaseRecord> {
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Update release failed with ${res.status}`);
  }
  return body.release;
}

/** Delete a release (admin-only); its items are unscheduled, not deleted. */
export async function deleteRelease(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete release failed with ${res.status}`);
  }
}

/**
 * The work scheduled into a release, grouped by hierarchy level (top level
 * first). `count` is the number of items the caller may read, which can be
 * fewer than the release's own `itemCount`.
 */
export async function getReleaseItems(
  id: string,
): Promise<{ groups: ReleaseItemGroup[]; count: number }> {
  const res = await apiFetch(
    `/api/v1/releases/${encodeURIComponent(id)}/items`,
  );
  const body = (await res.json().catch(() => null)) as {
    groups?: ReleaseItemGroup[];
    count?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.groups) {
    throw new Error(
      body?.error ?? `Failed to load release items (${res.status}).`,
    );
  }
  return { groups: body.groups, count: body.count ?? 0 };
}

// ── Cycles ────────────────────────────────────────────────────────────────

/** Create a cycle; returns the created record (with its derived state). */
export async function createCycle(input: CycleInput): Promise<CycleRecord> {
  const res = await apiFetch("/api/v1/cycles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    cycle?: CycleRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.cycle) {
    throw new Error(body?.error ?? `Create cycle failed with ${res.status}`);
  }
  return body.cycle;
}

/**
 * Generate a run of cycles from a cadence and a horizon. Returns every cycle
 * created, in date order. All or nothing: a name clash creates none of them.
 */
export async function generateCycles(
  input: CycleGenerateInput,
): Promise<CycleRecord[]> {
  const res = await apiFetch("/api/v1/cycles/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    cycles?: CycleRecord[];
    error?: string;
  } | null;
  if (!res.ok || !body?.cycles) {
    throw new Error(body?.error ?? `Generate cycles failed with ${res.status}`);
  }
  return body.cycles;
}

/** Update a cycle's name, dates, notes or product; returns the updated record. */
export async function updateCycle(
  id: string,
  patch: CyclePatch,
): Promise<CycleRecord> {
  const res = await apiFetch(`/api/v1/cycles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    cycle?: CycleRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.cycle) {
    throw new Error(body?.error ?? `Update cycle failed with ${res.status}`);
  }
  return body.cycle;
}

/** Delete a cycle. Its items are unscheduled, not deleted. */
export async function deleteCycle(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/cycles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete cycle failed with ${res.status}`);
  }
}

/** Move a cycle's unfinished work into another cycle; returns how many moved. */
export async function rolloverCycle(
  fromCycleId: string,
  toCycleId: string,
): Promise<{ moved: number; toCycleId: string }> {
  const res = await apiFetch(
    `/api/v1/cycles/${encodeURIComponent(fromCycleId)}/rollover`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toCycleId }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    moved?: number;
    toCycleId?: string;
    error?: string;
  } | null;
  if (!res.ok || typeof body?.moved !== "number") {
    throw new Error(body?.error ?? `Rollover failed with ${res.status}`);
  }
  return { moved: body.moved, toCycleId };
}

// ── Goals ─────────────────────────────────────────────────────────────────

/** Create a goal; returns the created record. */
export async function createGoal(input: GoalInput): Promise<GoalRecord> {
  return goalRequest(
    "/api/v1/goals",
    { method: "POST", body: input },
    "Create goal",
  );
}

/** Update a goal's metadata; returns the updated record. */
export async function updateGoal(
  id: string,
  patch: GoalPatch,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/goals/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
    "Update goal",
  );
}

/** Delete a goal. Linked work items are untouched. */
export async function deleteGoal(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete goal failed with ${res.status}`);
  }
}

/** Add a key result; returns the goal with its recomputed progress. */
export async function createKeyResult(
  goalId: string,
  input: KeyResultCreateBody,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/goals/${encodeURIComponent(goalId)}/key-results`,
    { method: "POST", body: input },
    "Add key result",
  );
}

/** Update a key result; returns the goal with its recomputed progress. */
export async function updateKeyResult(
  id: string,
  patch: KeyResultPatch,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/key-results/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
    "Update key result",
  );
}

/** Delete a key result; returns the goal with its recomputed progress. */
export async function deleteKeyResult(id: string): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/key-results/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "Delete key result",
  );
}

/** Link or unlink a work item to a goal; returns the refreshed contributions. */
export async function setGoalLink(
  goalId: string,
  specId: string,
  linked: boolean,
): Promise<GoalContribution[]> {
  const base = `/api/v1/goals/${encodeURIComponent(goalId)}/links`;
  const res = linked
    ? await apiFetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specId }),
      })
    : await apiFetch(`${base}?specId=${encodeURIComponent(specId)}`, {
        method: "DELETE",
      });
  const body = (await res.json().catch(() => null)) as {
    contributions?: GoalContribution[];
    error?: string;
  } | null;
  if (!res.ok || !body?.contributions) {
    throw new Error(body?.error ?? `Goal link failed with ${res.status}`);
  }
  return body.contributions;
}

/** Shared shape for the goal endpoints, all of which return `{ goal }`. */
async function goalRequest(
  path: string,
  init: { method: string; body?: unknown },
  label: string,
): Promise<GoalRecord> {
  const res = await apiFetch(path, {
    method: init.method,
    ...(init.body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(init.body),
        }
      : {}),
  });
  const body = (await res.json().catch(() => null)) as {
    goal?: GoalRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.goal) {
    throw new Error(body?.error ?? `${label} failed with ${res.status}`);
  }
  return body.goal;
}
