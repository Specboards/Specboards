import { apiFetch } from "./request";

/**
 * The two things a person can do to a run in flight.
 *
 * Listing is not here: runs arrive with the item's own page data, so the card
 * can show that an agent is working without waiting on a second request. This
 * module is only for acting on one.
 */

/** A run as the item card renders it. */
export interface RunView {
  id: string;
  status: string;
  trigger: string;
  summary: string | null;
  error: string | null;
  steer: string | null;
  trace: { at: string; label: string; detail?: string }[];
  agentId: string | null;
  actorType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Null when we did not do the spending, which is not the same as zero. */
  tokens: { prompt: number; completion: number } | null;
}

async function patch(
  runId: string,
  body: Record<string, unknown>,
): Promise<{ run: RunView | null; alreadyFinished?: boolean }> {
  const res = await apiFetch(`/api/v1/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { run: RunView | null; alreadyFinished?: boolean; error?: string }
    | null;
  if (!res.ok || !parsed) {
    throw new Error(parsed?.error ?? `Could not update the run (${res.status}).`);
  }
  return parsed;
}

/**
 * Ask a run to stop.
 *
 * `alreadyFinished` rather than an error when there was nothing to stop: the
 * person wanted it stopped and it is stopped, so telling them off for being
 * a second late would be the wrong response to getting what they asked for.
 */
export function cancelRun(runId: string) {
  return patch(runId, { cancel: true });
}

/** Leave a note the agent collects on its next report. */
export function steerRun(runId: string, steer: string) {
  return patch(runId, { steer });
}
