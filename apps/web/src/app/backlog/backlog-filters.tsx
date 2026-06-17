"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui/select";
import { priorityLabel, statusLabel } from "@/lib/feature-helpers";
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
  priorities: number[];
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
  const [pending, startTransition] = useTransition();

  function update(next: FeatureFilters) {
    const query = filtersToQuery(next);
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

  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending}>
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
          className="h-8 w-auto"
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

      <Select
        aria-label="Filter by priority"
        className="h-8 w-auto"
        value={filters.priority ?? ""}
        onChange={(e) =>
          set("priority", e.target.value === "" ? undefined : Number(e.target.value))
        }
      >
        <option value="">Any priority</option>
        {options.priorities.map((p) => (
          <option key={p} value={p}>
            {priorityLabel(p)}
          </option>
        ))}
      </Select>

      {options.tags.length > 0 ? (
        <Select
          aria-label="Filter by tag"
          className="h-8 w-auto"
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
          className="h-8 w-auto"
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
