import { generateKeyBetween } from "fractional-indexing";

import { defaultWorkflow, type StatusWorkflow } from "@specboard/core";

import type { FeatureRecord } from "./store/types";

/**
 * Human label for a status key. Prefers the workflow's explicit label (set by
 * an admin-defined workflow), falling back to a title-cased key so built-in and
 * config-driven statuses read well without any label map.
 */
export function statusLabel(status: string, workflow?: StatusWorkflow): string {
  const custom = workflow?.labels?.[status];
  if (custom) return custom;
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The fixed RICE impact scale, most to least impactful. */
export const RICE_IMPACT_OPTIONS = [
  { value: 3, label: "Massive (3×)" },
  { value: 2, label: "High (2×)" },
  { value: 1, label: "Medium (1×)" },
  { value: 0.5, label: "Low (0.5×)" },
  { value: 0.25, label: "Minimal (0.25×)" },
] as const;

/** Allowed impact multipliers (for validation). */
export const RICE_IMPACT_VALUES: readonly number[] = RICE_IMPACT_OPTIONS.map(
  (o) => o.value,
);

/** The four RICE inputs on a feature (any may be unset). */
export interface RiceInputs {
  riceReach: number | null;
  riceImpact: number | null;
  riceConfidence: number | null;
  riceEffort: number | null;
}

/**
 * RICE score = Reach × Impact × (Confidence / 100) ÷ Effort. Null unless every
 * input is present and effort is positive, so a partially-filled feature shows
 * no misleading score.
 */
export function computeRiceScore(i: RiceInputs): number | null {
  const { riceReach: r, riceImpact: im, riceConfidence: c, riceEffort: e } = i;
  if (r == null || im == null || c == null || e == null || e <= 0) return null;
  return (r * im * (c / 100)) / e;
}

/** The four inputs plus the derived score, for building a FeatureRecord. */
export function riceFields(i: RiceInputs): RiceInputs & { riceScore: number | null } {
  return { ...i, riceScore: computeRiceScore(i) };
}

/**
 * Per-status accent for the small dot next to status text (default workflow).
 * Hues track Primer's semantic labels: cool gray for open/neutral, accent blue
 * for ready, attention amber for in-progress, purple for spec/definition work,
 * and success green for done. Grays use `slate` (cool-biased) to sit with the
 * Primer neutral palette rather than the old chroma-zero `zinc`.
 */
export const statusDotClass: Record<string, string> = {
  backlog: "bg-slate-400",
  defining: "bg-purple-400",
  ready: "bg-blue-500",
  in_progress: "bg-amber-400",
  in_review: "bg-pink-400",
  done: "bg-green-500",
  archived: "bg-slate-300",
};

/** Palette for custom statuses not in the default map (assigned deterministically). */
const FALLBACK_DOT_CLASSES = [
  "bg-purple-400",
  "bg-blue-500",
  "bg-amber-400",
  "bg-pink-400",
  "bg-green-500",
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

/** Statuses a feature may move to from `status` (current first, for selects). */
export function statusOptions(
  status: string,
  workflow: StatusWorkflow = defaultWorkflow,
): string[] {
  const next = workflow.transitions[status] ?? [];
  return [status, ...next.filter((s) => s !== status)];
}

/** Stable default ordering: by title. */
export function sortFeatures(features: FeatureRecord[]): FeatureRecord[] {
  return [...features].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Order cards within a board column: manually-ranked cards first (by lexical
 * rank), then unranked cards by title. Cards gain a rank lazily the first
 * time they're dragged, so a fresh board keeps today's ordering and converges
 * on manual order as it's used.
 */
export function sortBoardCards(features: FeatureRecord[]): FeatureRecord[] {
  return [...features].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * A fractional rank that sorts between `prev` and `next` (either may be null
 * for an open boundary). Used to persist a card's new position after a drag.
 */
export function rankBetween(
  prev: string | null,
  next: string | null,
): string {
  return generateKeyBetween(prev, next);
}
