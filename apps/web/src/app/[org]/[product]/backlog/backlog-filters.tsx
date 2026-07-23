"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui/select";
import { statusLabel } from "@/lib/feature-helpers";
import {
  filtersToQuery,
  hasActiveFilters,
  type FeatureFilters,
} from "@/lib/feature-filters";

export interface FilterOptions {
  statuses: string[];
  assignees: { userId: string; name: string }[];
  tags: string[];
  epics: { specId: string; title: string }[];
  releases: { id: string; name: string }[];
  /** Products to filter by; provided only in the cross-product view. */
  products?: { id: string; name: string }[];
}

/**
 * Backlog filter bar. Holds no state of its own — the active filters live in
 * the URL (parsed server-side), and each control pushes an updated query so the
 * filtered view is shareable and survives refresh.
 */
export function BacklogFilters({
  filters,
  options,
}: {
  filters: FeatureFilters;
  options: FilterOptions;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(next: FeatureFilters) {
    // Rebuild the query from the filters, preserving the non-filter `view`
    // param so clearing filters doesn't bounce the list view back to board.
    const params = new URLSearchParams(filtersToQuery(next));
    const view = searchParams.get("view");
    if (view) params.set("view", view);
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  function set<K extends keyof FeatureFilters>(
    key: K,
    value: FeatureFilters[K] | undefined,
  ) {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    update(next);
  }

  const active = hasActiveFilters(filters);

  // Every filter select is a fixed `w-40` rather than `w-auto`: a native
  // <select> sizes to its widest option, so a long option (e.g. an epic title
  // under "Any parent") would otherwise stretch that control far wider than the
  // rest. A uniform width keeps the row even; long selected values truncate.
  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending}>
      {options.products && options.products.length > 0 ? (
        <Select
          aria-label="Filter by product"
          className="h-8 w-40"
          value={filters.product ?? ""}
          onChange={(e) => set("product", e.target.value || undefined)}
        >
          <option value="">Any product</option>
          {options.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      ) : null}

      <Select
        aria-label="Filter by status"
        className="h-8 w-auto"
        value={filters.status ?? ""}
        onChange={(e) => set("status", e.target.value || undefined)}
      >
        <option value="">Any status</option>
        {options.statuses.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </Select>

      {options.assignees.length > 0 ? (
        <Select
          aria-label="Filter by assignee"
          className="h-8 w-40"
          value={filters.assignee ?? ""}
          onChange={(e) => set("assignee", e.target.value || undefined)}
        >
          <option value="">Any assignee</option>
          <option value="unassigned">Unassigned</option>
          {options.assignees.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name}
            </option>
          ))}
        </Select>
      ) : null}

      {options.releases.length > 0 ? (
        <Select
          aria-label="Filter by release"
          className="h-8 w-40"
          value={filters.release ?? ""}
          onChange={(e) => set("release", e.target.value || undefined)}
        >
          <option value="">Any release</option>
          <option value="none">No release</option>
          {options.releases.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      ) : null}

      {options.tags.length > 0 ? (
        <Select
          aria-label="Filter by tag"
          className="h-8 w-40"
          value={filters.tag ?? ""}
          onChange={(e) => set("tag", e.target.value || undefined)}
        >
          <option value="">Any tag</option>
          {options.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      ) : null}

      {options.epics.length > 0 ? (
        <Select
          aria-label="Filter by parent epic"
          className="h-8 w-40"
          value={filters.parent ?? ""}
          onChange={(e) => set("parent", e.target.value || undefined)}
        >
          <option value="">Any parent</option>
          <option value="none">Top-level only</option>
          {options.epics.map((ep) => (
            <option key={ep.specId} value={ep.specId}>
              {ep.title}
            </option>
          ))}
        </Select>
      ) : null}

      {active ? (
        <button
          type="button"
          onClick={() => update({})}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
