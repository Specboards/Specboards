"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui/select";
import type { SortMode } from "@/lib/feature-helpers";

/** A selectable custom-field sort: `cf:<key>` value and its display label. */
export interface CustomSortOption {
  value: string;
  label: string;
}

/**
 * Backlog sort control. Like the filter bar it holds no state of its own - the
 * active sort lives in the URL (`?sort=`), parsed server-side - so a sorted view
 * is shareable and survives refresh. "Default" keeps each view's natural order
 * (hierarchy/rank); "RICE score" ranks by computed priority, highest first;
 * `customSorts` add one option per sortable workspace custom property.
 */
export function SortControl({
  sort,
  customSorts = [],
}: {
  sort: SortMode;
  customSorts?: CustomSortOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function set(next: SortMode) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "default") params.delete("sort");
    else params.set("sort", next);
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  return (
    <Select
      aria-label="Sort by"
      className="h-8 w-40"
      value={sort}
      disabled={pending}
      onChange={(e) => set(e.target.value as SortMode)}
    >
      <option value="default">Sort: Default</option>
      <option value="rice">Sort: RICE score</option>
      {customSorts.map((c) => (
        <option key={c.value} value={c.value}>
          Sort: {c.label}
        </option>
      ))}
    </Select>
  );
}
