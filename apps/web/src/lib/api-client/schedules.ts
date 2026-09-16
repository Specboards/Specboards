import { apiFetch } from "./request";

/**
 * Creating, editing and removing schedules from the browser.
 *
 * Listing is not here for the settings page, which is a server component and
 * reads the rows directly. It IS here for the item card, which appears inside
 * a page whose data was already assembled before schedules existed, and adding
 * a field to that loader for a list most items will never have is a worse
 * trade than one small request on the cards that do.
 */

/** A schedule as either surface renders it. Mirrors the service's view. */
export interface ScheduleView {
  id: string;
  name: string;
  skillKey: string;
  targetSpecId: string;
  cadence: {
    every: "day" | "week" | "month";
    hour: number;
    minute: number;
    weekday?: number;
    day?: number;
  };
  timeZone: string;
  /** The cadence as a sentence, resolved on the server so surfaces agree. */
  cadenceLabel: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/** The message the API sent, or a fallback naming the status. */
async function failure(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `${fallback} (${res.status}).`);
}

/**
 * The item-surface skills this workspace offers, for the schedule form's picker.
 *
 * Read here rather than threaded through the item page's loader: most items
 * will never have a schedule, and widening that payload for every card in the
 * workspace to serve the few that do is the worse trade. Disabled skills are
 * dropped for the same reason `list_skills` drops them over MCP: off means the
 * team decided their assistant should not do that, and scheduling one would be
 * a way to keep it running anyway.
 */
export async function listSchedulableSkills(): Promise<
  { key: string; name: string }[]
> {
  const res = await apiFetch("/api/v1/assistant-skills", { method: "GET" });
  if (!res.ok) await failure(res, "Could not load the skills");
  const body = (await res.json()) as {
    skills: { key: string; name: string; surface: string; enabled: boolean }[];
  };
  return body.skills
    .filter((s) => s.enabled && s.surface === "item")
    .map((s) => ({ key: s.key, name: s.name }));
}

export async function listSchedules(): Promise<ScheduleView[]> {
  const res = await apiFetch("/api/v1/schedules", { method: "GET" });
  if (!res.ok) await failure(res, "Could not load the schedules");
  const body = (await res.json()) as { schedules: ScheduleView[] };
  return body.schedules;
}

export async function createSchedule(input: {
  name: string;
  skillKey: string;
  specId: string;
  cadence: Record<string, unknown>;
  timeZone: string;
}): Promise<ScheduleView> {
  const res = await apiFetch("/api/v1/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await failure(res, "Could not create the schedule");
  const body = (await res.json()) as { schedule: ScheduleView };
  return body.schedule;
}

export async function updateSchedule(
  id: string,
  patch: Record<string, unknown>,
): Promise<ScheduleView> {
  const res = await apiFetch(`/api/v1/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await failure(res, "Could not update the schedule");
  const body = (await res.json()) as { schedule: ScheduleView };
  return body.schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  // 204 is the success here, and `res.ok` covers it; a 404 means somebody else
  // already removed it, which is the outcome the caller wanted either way.
  if (!res.ok && res.status !== 404) {
    await failure(res, "Could not delete the schedule");
  }
}
