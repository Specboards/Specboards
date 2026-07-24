import type { FeatureRecord } from "@/lib/store/types";

/**
 * Backlog filter state. Each dimension is single-valued and round-trips through
 * the URL query string so a filtered view is shareable/bookmarkable. Special
 * sentinels: `assignee="unassigned"`, `parent="none"` (top-level only), and
 * `release="none"` (unscheduled only).
 */
export interface FeatureFilters {
  status?: string;
  assignee?: string;
  release?: string;
  tag?: string;
  parent?: string;
  /** Owning product id; only meaningful in the cross-product view. */
  product?: string;
  /**
   * Inclusive date ranges on `date`-typed custom fields, keyed by property key.
   * An item passes when its value falls within every active range; an empty
   * value is excluded once a range is set. Round-trips as `cf_<key>_from` /
   * `cf_<key>_to` in the query string.
   */
  customDates?: Record<string, { from?: string; to?: string }>;
  /**
   * Show items that are done and scheduled into a shipped release, which the
   * backlog hides by default. A view toggle rather than a filter dimension: it
   * does not count toward the active-filter total. Round-trips as
   * `showShipped=1`.
   */
  showShipped?: boolean;
}

/** The single-value query keys — also the order the filter bar renders them. */
export const FILTER_KEYS = [
  "status",
  "assignee",
  "release",
  "tag",
  "parent",
  "product",
] as const;

/** Query param for the start of a custom date field's range. */
function dateFromParam(key: string): string {
  return `cf_${key}_from`;
}

/** Query param for the end of a custom date field's range. */
function dateToParam(key: string): string {
  return `cf_${key}_to`;
}

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
  const release = first(params.release);
  if (release) filters.release = release;
  const tag = first(params.tag);
  if (tag) filters.tag = tag;
  const parent = first(params.parent);
  if (parent) filters.parent = parent;
  const product = first(params.product);
  if (product) filters.product = product;
  if (first(params.showShipped)) filters.showShipped = true;
  return filters;
}

/**
 * Drop items that are done AND scheduled into a shipped release, keeping
 * finished-and-shipped work out of the everyday backlog. A no-op when the
 * workspace has no shipped releases. Applied before the user filters and the
 * hierarchy grouping, independent of whether any filter is active, so it is the
 * default view unless `showShipped` is set.
 */
export function hideDoneShippedItems(
  features: FeatureRecord[],
  shippedReleaseIds: ReadonlySet<string>,
): FeatureRecord[] {
  if (shippedReleaseIds.size === 0) return features;
  return features.filter(
    (f) =>
      !(
        f.status === "done" &&
        f.releaseId !== null &&
        shippedReleaseIds.has(f.releaseId)
      ),
  );
}

/**
 * Parse date-range params for the given date-field keys into a `customDates`
 * map. Only known keys are read (the caller passes the workspace's date-typed
 * property keys), so a stale or hand-typed param for a removed field is ignored.
 * Values must be ISO `YYYY-MM-DD`; anything else is dropped.
 */
export function parseCustomDateFilters(
  params: RawParams,
  dateKeys: readonly string[],
): Record<string, { from?: string; to?: string }> {
  const out: Record<string, { from?: string; to?: string }> = {};
  const iso = (v: string | undefined) =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  for (const key of dateKeys) {
    const from = iso(first(params[dateFromParam(key)]));
    const to = iso(first(params[dateToParam(key)]));
    if (from || to) out[key] = { ...(from && { from }), ...(to && { to }) };
  }
  return out;
}

/** The count of active custom date-range filters. */
function customDateCount(filters: FeatureFilters): number {
  return filters.customDates ? Object.keys(filters.customDates).length : 0;
}

/** True when at least one filter dimension is set. */
export function hasActiveFilters(filters: FeatureFilters): boolean {
  return (
    FILTER_KEYS.some((k) => filters[k] !== undefined) ||
    customDateCount(filters) > 0
  );
}

/** How many filter dimensions are set — drives the mobile "Filters" badge. */
export function countActiveFilters(filters: FeatureFilters): number {
  return (
    FILTER_KEYS.filter((k) => filters[k] !== undefined).length +
    customDateCount(filters)
  );
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
    if (filters.release) {
      if (filters.release === "none") {
        if (f.releaseId !== null) return false;
      } else if (f.releaseId !== filters.release) {
        return false;
      }
    }
    if (filters.tag && !f.tags.includes(filters.tag)) return false;
    if (filters.parent) {
      if (filters.parent === "none") {
        if (f.parentSpecId !== null) return false;
      } else if (f.parentSpecId !== filters.parent) {
        return false;
      }
    }
    if (filters.product && f.productId !== filters.product) return false;
    if (filters.customDates) {
      for (const [key, range] of Object.entries(filters.customDates)) {
        const raw = f.customFields[key];
        // ISO YYYY-MM-DD strings compare correctly lexically; an empty value
        // falls outside any active range.
        const v = typeof raw === "string" && raw.trim() !== "" ? raw : null;
        if (range.from && (v === null || v < range.from)) return false;
        if (range.to && (v === null || v > range.to)) return false;
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
  for (const [key, range] of Object.entries(filters.customDates ?? {})) {
    if (range.from) params.set(dateFromParam(key), range.from);
    if (range.to) params.set(dateToParam(key), range.to);
  }
  if (filters.showShipped) params.set("showShipped", "1");
  return params.toString();
}
