import type { FeatureRecord } from "@/lib/store/types";

/**
 * Backlog filter state.
 *
 * Each dimension holds a *list* of accepted values: an item passes a dimension
 * when it matches any one of them (OR), and passes overall when it clears every
 * dimension (AND). "Ready or In progress, assigned to me" is one question, and
 * before this it could not be asked at all -- you got one status, or none.
 *
 * The lists round-trip through the URL query string as repeated params
 * (`?status=ready&status=in_progress`) so a filtered view stays shareable and
 * bookmarkable. Repeated rather than comma-joined because a value is arbitrary
 * user data (a tag name), and a separator inside a value is a bug waiting for
 * the first person who uses one.
 *
 * A single-valued URL from before this change still parses: one param, one
 * entry in the list. Nothing needs rewriting and old links keep working.
 *
 * Special sentinels: `assignee="unassigned"`, `parent="none"` (top-level only),
 * `release="none"` (unscheduled only), and `cycle="none"` (in no cycle).
 */
export interface FeatureFilters {
  status?: string[];
  assignee?: string[];
  release?: string[];
  /** Owning cycle ids, or "none" for items in no cycle. Independent of
   * `release`: both can be set, and they narrow on different axes. */
  cycle?: string[];
  tag?: string[];
  parent?: string[];
  /** Owning product ids; only meaningful in the cross-product view. */
  product?: string[];
  /**
   * Inclusive date ranges on `date`-typed custom fields, keyed by property key.
   * An item passes when its value falls within every active range; an empty
   * value is excluded once a range is set. Round-trips as `cf_<key>_from` /
   * `cf_<key>_to` in the query string.
   *
   * A range, not a list: "between these two dates" already expresses the set,
   * and two ranges OR'd together is a question nobody has asked for.
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

/** The multi-value query keys — also the order the filter bar renders them. */
export const FILTER_KEYS = [
  "status",
  "assignee",
  "release",
  "cycle",
  "tag",
  "parent",
  "product",
] as const;

/** A dimension that holds a list of accepted values. */
export type FilterKey = (typeof FILTER_KEYS)[number];

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

/**
 * Every non-empty value a param carries, de-duplicated and in the order given.
 * Accepts the scalar shape too, which is what a single-valued (pre-multi-select)
 * link and Next's own searchParams both hand over.
 */
function values(value: string | string[] | undefined): string[] | undefined {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const v of raw) {
    const trimmed = v?.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

/** Parse untrusted searchParams into a {@link FeatureFilters}. */
export function parseFeatureFilters(params: RawParams): FeatureFilters {
  const filters: FeatureFilters = {};
  for (const key of FILTER_KEYS) {
    const list = values(params[key]);
    if (list) filters[key] = list;
  }
  if (first(params.showShipped)) filters.showShipped = true;
  return filters;
}

/**
 * Add or remove one value in a dimension, returning fresh filters.
 *
 * The whole interaction model for a multi-value filter is this one function:
 * every menu row is a toggle, an unchecked last value drops the dimension (and
 * so its chip), and there is no separate "clear this one" path to keep in step.
 */
export function toggleFilterValue(
  filters: FeatureFilters,
  key: FilterKey,
  value: string,
): FeatureFilters {
  const current = filters[key] ?? [];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const out = { ...filters };
  if (next.length > 0) out[key] = next;
  else delete out[key];
  return out;
}

/** Drop a whole dimension (the chip's "Remove filter"). */
export function clearFilterKey(
  filters: FeatureFilters,
  key: FilterKey,
): FeatureFilters {
  const out = { ...filters };
  delete out[key];
  return out;
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
    FILTER_KEYS.some((k) => (filters[k]?.length ?? 0) > 0) ||
    customDateCount(filters) > 0
  );
}

/**
 * How many filter dimensions are set -- what the toolbar button's badge shows.
 *
 * Dimensions, not values: "Status is Ready or In progress" is one filter the
 * user set, and counting it as two would make the badge climb every time they
 * widened a filter rather than added one.
 */
export function countActiveFilters(filters: FeatureFilters): number {
  return (
    FILTER_KEYS.filter((k) => (filters[k]?.length ?? 0) > 0).length +
    customDateCount(filters)
  );
}

/** Does this item match any of a dimension's accepted values? */
function matchesAny(
  accepted: string[] | undefined,
  /** The item's value for this dimension; null means "not set on the item". */
  actual: string | null,
  /** The sentinel that stands for "not set", if this dimension has one. */
  noneSentinel?: string,
): boolean {
  if (!accepted || accepted.length === 0) return true;
  return accepted.some((want) =>
    noneSentinel !== undefined && want === noneSentinel
      ? actual === null
      : actual === want,
  );
}

/** Apply the filters to a feature list (OR within a dimension, AND across). */
export function applyFeatureFilters(
  features: FeatureRecord[],
  filters: FeatureFilters,
): FeatureRecord[] {
  return features.filter((f) => {
    if (!matchesAny(filters.status, f.status)) return false;
    if (!matchesAny(filters.assignee, f.assigneeId, "unassigned")) return false;
    if (!matchesAny(filters.release, f.releaseId, "none")) return false;
    if (!matchesAny(filters.cycle, f.cycleId, "none")) return false;
    if (!matchesAny(filters.parent, f.parentSpecId, "none")) return false;
    if (!matchesAny(filters.product, f.productId)) return false;
    // Tags are the one many-to-many dimension: the item carries a list too, so
    // it passes when the two lists intersect at all.
    if (
      filters.tag &&
      filters.tag.length > 0 &&
      !filters.tag.some((t) => f.tags.includes(t))
    ) {
      return false;
    }
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
    for (const value of filters[key] ?? []) params.append(key, value);
  }
  for (const [key, range] of Object.entries(filters.customDates ?? {})) {
    if (range.from) params.set(dateFromParam(key), range.from);
    if (range.to) params.set(dateToParam(key), range.to);
  }
  if (filters.showShipped) params.set("showShipped", "1");
  return params.toString();
}
