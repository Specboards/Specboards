import { generateKeyBetween } from "fractional-indexing";

import {
  defaultWorkflow,
  type PropertyDef,
  type PropertyType,
  type StatusWorkflow,
} from "@specboards/core";
import { fallbackStatusDots, statusColors } from "@specboards/ui";

import type { CustomFieldValue, FeatureRecord } from "./store/types";

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

/** A RICE score as a compact display string ("—" when unscored). */
export function formatRiceScore(score: number | null): string {
  if (score == null) return "—";
  return score.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Order features by RICE score, highest first; unscored last, then by title. */
export function compareByRiceScore(
  a: Pick<FeatureRecord, "riceScore" | "title">,
  b: Pick<FeatureRecord, "riceScore" | "title">,
): number {
  if (a.riceScore !== b.riceScore) {
    if (a.riceScore == null) return 1;
    if (b.riceScore == null) return -1;
    return b.riceScore - a.riceScore;
  }
  return a.title.localeCompare(b.title);
}

/**
 * The backlog sort modes selectable in the UI. Beyond the two built-ins, a
 * `cf:<key>` mode sorts by a workspace custom property (see
 * {@link compareByCustomField}); the key is a property's stable `custom_fields`
 * key.
 */
export type SortMode = "default" | "rice" | `cf:${string}`;

/** Prefix marking a {@link SortMode} that targets a custom property. */
export const CUSTOM_SORT_PREFIX = "cf:";

/**
 * Property types we can meaningfully order a backlog by. `multiselect` and
 * `user` are excluded: a set of tags has no natural order, and a user id sorts
 * by an opaque uuid rather than a name.
 */
export const SORTABLE_PROPERTY_TYPES: readonly PropertyType[] = [
  "date",
  "number",
  "text",
  "select",
  "url",
];

/** Whether a property can back a `cf:` sort mode. */
export function isSortableProperty(p: Pick<PropertyDef, "type">): boolean {
  return SORTABLE_PROPERTY_TYPES.includes(p.type);
}

/** The sortable properties, in definition order (for building sort options). */
export function sortableProperties(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter(isSortableProperty);
}

/**
 * Parse an untrusted `sort` search-param value. A `cf:<key>` value is only
 * honored when `<key>` is one of `sortableKeys` (the workspace's sortable
 * property keys), so a stale or hand-typed param falls back to default rather
 * than sorting by a field that no longer exists.
 */
export function parseSortMode(
  value: string | string[] | undefined,
  sortableKeys: readonly string[] = [],
): SortMode {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === "rice") return "rice";
  if (v && v.startsWith(CUSTOM_SORT_PREFIX)) {
    const key = v.slice(CUSTOM_SORT_PREFIX.length);
    if (sortableKeys.includes(key)) return v as SortMode;
  }
  return "default";
}

/**
 * A comparable sort key for one custom-field value, or null when the value is
 * empty (unset, blank, or an empty list) so empties can be forced last. Numbers
 * sort numerically; everything else sorts as trimmed text (ISO `YYYY-MM-DD`
 * dates sort correctly lexically).
 */
function customFieldSortKey(
  value: CustomFieldValue,
  type: PropertyType,
): string | number | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(", ") : null;
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Order features by a custom property (ascending), empty values last, ties
 * broken by title. `type` selects numeric vs text comparison; pass the
 * property's declared type so dates and numbers order correctly.
 */
export function compareByCustomField(
  key: string,
  type: PropertyType,
): (a: FeatureRecord, b: FeatureRecord) => number {
  return (a, b) => {
    const av = customFieldSortKey(a.customFields[key] ?? null, type);
    const bv = customFieldSortKey(b.customFields[key] ?? null, type);
    if (av === null || bv === null) {
      if (av === bv) return a.title.localeCompare(b.title);
      return av === null ? 1 : -1;
    }
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av - bv;
    } else {
      const c = String(av).localeCompare(String(bv), undefined, {
        numeric: true,
      });
      if (c !== 0) return c;
    }
    return a.title.localeCompare(b.title);
  };
}

/**
 * Dot color (a hex value) for any status: the shared design-system color from
 * `statusColors` when the status is in the default workflow, otherwise a stable
 * color hashed from the status name so custom statuses stay consistent. Render
 * it as a decorative, label-paired swatch via inline `background-color`; the
 * shared token map is the single source both the app and Gesso read from.
 */
export function statusDotColor(status: string): string {
  const known = statusColors[status];
  if (known) return known.dot;
  let hash = 0;
  for (let i = 0; i < status.length; i++) {
    hash = (hash * 31 + status.charCodeAt(i)) >>> 0;
  }
  return fallbackStatusDots[hash % fallbackStatusDots.length] ?? "#9ca3af";
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
