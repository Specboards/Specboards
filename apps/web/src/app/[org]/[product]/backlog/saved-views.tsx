"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AuthRequiredError, deleteView, saveView } from "@/lib/api-client";
import {
  FILTER_KEYS,
  filtersToQuery,
  hasActiveFilters,
  type FeatureFilters,
} from "@/lib/feature-filters";
import type { SavedView, SavedViewFilters } from "@/lib/store/types";
import { Button } from "@/components/ui/button";

/** Build a query string from a stored filter bundle (stable key order). */
function viewQuery(filters: SavedViewFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Narrow the current FeatureFilters into the persisted-filter shape. */
function toSavedFilters(filters: FeatureFilters): SavedViewFilters {
  const out: SavedViewFilters = {};
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Saved-view chips + a "Save current" action. Views are personal (per user);
 * applying one just navigates to the backlog with its stored query, so the URL
 * stays the single source of truth for the active filters.
 */
export function SavedViews({
  views,
  currentFilters,
  canEdit,
}: {
  views: SavedView[];
  currentFilters: FeatureFilters;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const currentQuery = filtersToQuery(currentFilters);
  const filtersActive = hasActiveFilters(currentFilters);
  const alreadySaved = views.some((v) => viewQuery(v.filters) === currentQuery);

  function apply(filters: SavedViewFilters) {
    const query = viewQuery(filters);
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  function onSave() {
    const name = window.prompt("Name this view")?.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      try {
        await saveView({
          name,
          view: "backlog",
          filters: toSavedFilters(currentFilters),
        });
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(`/sign-in?from=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  function onDelete(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteView(id);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(`/sign-in?from=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  if (views.length === 0 && !filtersActive) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending}>
      {views.length > 0 ? (
        <span className="text-xs font-medium text-muted-foreground">Views:</span>
      ) : null}
      {views.map((v) => {
        const isActive = viewQuery(v.filters) === currentQuery;
        return (
          <span
            key={v.id}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              isActive ? "border-foreground bg-muted" : "border-input"
            }`}
          >
            <Button
              variant="link"
              size="inline"
              onClick={() => apply(v.filters)}
              className="font-normal text-foreground underline-offset-2"
            >
              {v.name}
            </Button>
            {canEdit ? (
              <button
                type="button"
                onClick={() => onDelete(v.id)}
                aria-label={`Delete view ${v.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            ) : null}
          </span>
        );
      })}
      {canEdit && filtersActive && !alreadySaved ? (
        <Button
          variant="link"
          size="inline"
          onClick={onSave}
          className="text-xs font-normal text-muted-foreground underline-offset-2"
        >
          + Save current view
        </Button>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
