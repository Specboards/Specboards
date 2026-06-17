import type { FeatureRecord } from "@/lib/store/types";

/**
 * Backlog filter state. Each dimension is single-valued and round-trips through
 * the URL query string so a filtered view is shareable/bookmarkable. Special
 * sentinels: `assignee="unassigned"` and `parent="none"` (top-level only).
 */
export interface FeatureFilters {
  status?: string;
  assignee?: string;
  priority?: number;
  tag?: string;
  parent?: string;
}

/** The query keys we read/write — also the order the filter bar renders them. */
export const FILTER_KEYS = [
  "status",
  "assignee",
  "priority",
  "tag",
  "parent",
] as const;

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== "" ? v : undefined;
}

/** Parse untrusted searchParams into a {@link FeatureFilters}. */
export function parseFeatureFilters(params: RawParams): FeatureFilters {
  const filters: FeatureFilters = {};
  const status = first(params.status);
  if (status) filters.status = status;
  const assignee = first(params.assignee);
  if (assignee) filters.assignee = assignee;
  const priority = first(params.priority);
  if (priority !== undefined) {
    const n = Number(priority);
    if (Number.isInteger(n)) filters.priority = n;
  }
  const tag = first(params.tag);
  if (tag) filters.tag = tag;
  const parent = first(params.parent);
  if (parent) filters.parent = parent;
  return filters;
}

/** True when at least one filter dimension is set. */
export function hasActiveFilters(filters: FeatureFilters): boolean {
  return FILTER_KEYS.some((k) => filters[k] !== undefined);
}

/** Apply the filters to a feature list (AND across dimensions). */
export function applyFeatureFilters(
  features: FeatureRecord[],
  filters: FeatureFilters,
): FeatureRecord[] {
  return features.filter((f) => {
    if (filters.status && f.status !== filters.status) return false;
    if (filters.assignee) {
      if (filters.assignee === "unassigned") {
        if (f.assigneeId !== null) return false;
      } else if (f.assigneeId !== filters.assignee) {
        return false;
      }
    }
    if (filters.priority !== undefined && f.priority !== filters.priority)
      return false;
    if (filters.tag && !f.tags.includes(filters.tag)) return false;
    if (filters.parent) {
      if (filters.parent === "none") {
        if (f.parentSpecId !== null) return false;
      } else if (f.parentSpecId !== filters.parent) {
        return false;
      }
    }
    return true;
  });
}

/** Serialize filters into a URLSearchParams query string (stable key order). */
export function filtersToQuery(filters: FeatureFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}
