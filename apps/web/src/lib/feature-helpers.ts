import { defaultWorkflow, type StatusWorkflow } from "@specboard/core";

import type { FeatureRecord } from "./store/types";

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Per-status accent for the small dot next to status text (default workflow). */
export const statusDotClass: Record<string, string> = {
  backlog: "bg-zinc-400",
  defining: "bg-violet-400",
  ready: "bg-blue-400",
  in_progress: "bg-amber-400",
  in_review: "bg-pink-400",
  done: "bg-emerald-400",
  archived: "bg-zinc-300",
};

/** Palette for custom statuses not in the default map (assigned deterministically). */
const FALLBACK_DOT_CLASSES = [
  "bg-violet-400",
  "bg-blue-400",
  "bg-amber-400",
  "bg-pink-400",
  "bg-emerald-400",
  "bg-cyan-400",
  "bg-rose-400",
  "bg-lime-400",
  "bg-indigo-400",
  "bg-teal-400",
];

/**
 * Dot color for any status: the default-workflow color when known, otherwise a
 * stable color hashed from the status name so custom statuses stay consistent.
 */
export function statusDotClassFor(status: string): string {
  const known = statusDotClass[status];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < status.length; i++) {
    hash = (hash * 31 + status.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_DOT_CLASSES[hash % FALLBACK_DOT_CLASSES.length] ?? "bg-zinc-400";
}

export function priorityLabel(priority: number | null): string {
  return priority === null ? "—" : `P${priority}`;
}

/** Statuses a feature may move to from `status` (current first, for selects). */
export function statusOptions(
  status: string,
  workflow: StatusWorkflow = defaultWorkflow,
): string[] {
  const next = workflow.transitions[status] ?? [];
  return [status, ...next.filter((s) => s !== status)];
}

/** Priority ascending (P0 first, unset last), then title. */
export function sortFeatures(features: FeatureRecord[]): FeatureRecord[] {
  return [...features].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.title.localeCompare(b.title);
  });
}
