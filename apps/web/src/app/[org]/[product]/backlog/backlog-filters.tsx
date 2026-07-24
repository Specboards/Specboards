"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { statusLabel } from "@/lib/feature-helpers";
import {
  countActiveFilters,
  filtersToQuery,
  hasActiveFilters,
  type FeatureFilters,
} from "@/lib/feature-filters";
import { cn } from "@/lib/utils";

export interface FilterOptions {
  statuses: string[];
  assignees: { userId: string; name: string }[];
  tags: string[];
  epics: { specId: string; title: string }[];
  releases: { id: string; name: string }[];
  /** Products to filter by; provided only in the cross-product view. */
  products?: { id: string; name: string }[];
  /** Date-typed custom fields, each offering a from/to range filter. */
  dateFields?: { key: string; label: string }[];
  /** Whether to offer the "Show shipped" toggle (any shipped release exists). */
  canShowShipped?: boolean;
}

/** One filter dimension, resolved to the options the current data set offers. */
interface FilterControl {
  key: keyof FeatureFilters;
  /** Short noun used as the field label inside the mobile sheet. */
  label: string;
  /** The "Any X" placeholder / accessible name. */
  placeholder: string;
  value: string;
  /** Sentinel options (e.g. "Unassigned") shown before the real values. */
  leading?: { value: string; label: string }[];
  options: { value: string; label: string }[];
  /** Desktop width; the status control sizes to content, the rest are uniform. */
  desktopWidth: string;
}

/**
 * Backlog filter bar. Holds no state of its own — the active filters live in
 * the URL (parsed server-side), and each control pushes an updated query so the
 * filtered view is shareable and survives refresh.
 *
 * On desktop the controls sit inline. On mobile they collapse behind a single
 * "Filters" button that opens a sheet, so the filter row never pushes the board
 * itself off the top of a phone screen.
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
  const [sheetOpen, setSheetOpen] = useState(false);

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

  /** Set or clear one end of a date-field range, dropping the field when empty. */
  function setDateRange(fieldKey: string, part: "from" | "to", value: string) {
    const range = { ...(filters.customDates?.[fieldKey] ?? {}) };
    if (value) range[part] = value;
    else delete range[part];
    const customDates = { ...filters.customDates };
    if (range.from || range.to) customDates[fieldKey] = range;
    else delete customDates[fieldKey];
    const next = { ...filters };
    if (Object.keys(customDates).length) next.customDates = customDates;
    else delete next.customDates;
    update(next);
  }

  const active = hasActiveFilters(filters);
  const activeCount = countActiveFilters(filters);

  // Build the list of controls once, from the options this data set actually
  // offers, then render it two ways (inline on desktop, stacked in the sheet on
  // mobile) so the two layouts can never drift apart.
  const controls: FilterControl[] = [];
  if (options.products && options.products.length > 0) {
    controls.push({
      key: "product",
      label: "Product",
      placeholder: "Any product",
      value: filters.product ?? "",
      options: options.products.map((p) => ({ value: p.id, label: p.name })),
      desktopWidth: "sm:w-40",
    });
  }
  controls.push({
    key: "status",
    label: "Status",
    placeholder: "Any status",
    value: filters.status ?? "",
    options: options.statuses.map((s) => ({ value: s, label: statusLabel(s) })),
    // Status sizes to content on desktop; the rest are a uniform w-40.
    desktopWidth: "sm:w-auto",
  });
  if (options.assignees.length > 0) {
    controls.push({
      key: "assignee",
      label: "Assignee",
      placeholder: "Any assignee",
      value: filters.assignee ?? "",
      leading: [{ value: "unassigned", label: "Unassigned" }],
      options: options.assignees.map((a) => ({
        value: a.userId,
        label: a.name,
      })),
      desktopWidth: "sm:w-40",
    });
  }
  if (options.releases.length > 0) {
    controls.push({
      key: "release",
      label: "Release",
      placeholder: "Any release",
      value: filters.release ?? "",
      leading: [{ value: "none", label: "No release" }],
      options: options.releases.map((r) => ({ value: r.id, label: r.name })),
      desktopWidth: "sm:w-40",
    });
  }
  if (options.tags.length > 0) {
    controls.push({
      key: "tag",
      label: "Tag",
      placeholder: "Any tag",
      value: filters.tag ?? "",
      options: options.tags.map((t) => ({ value: t, label: t })),
      desktopWidth: "sm:w-40",
    });
  }
  if (options.epics.length > 0) {
    controls.push({
      key: "parent",
      label: "Parent",
      placeholder: "Any parent",
      value: filters.parent ?? "",
      leading: [{ value: "none", label: "Top-level only" }],
      options: options.epics.map((ep) => ({
        value: ep.specId,
        label: ep.title,
      })),
      desktopWidth: "sm:w-40",
    });
  }

  // Every filter select is a fixed `w-40` rather than `w-auto`: a native
  // <select> sizes to its widest option, so a long option (e.g. an epic title
  // under "Any parent") would otherwise stretch that control far wider than the
  // rest. A uniform width keeps the row even; long selected values truncate.
  function renderSelect(c: FilterControl, widthClass: string) {
    return (
      <Select
        key={c.key}
        aria-label={`Filter by ${c.label.toLowerCase()}`}
        className={cn("h-8", widthClass)}
        value={c.value}
        onChange={(e) => set(c.key, e.target.value || undefined)}
      >
        <option value="">{c.placeholder}</option>
        {c.leading?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {c.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }

  // A from/to date-range control for one date-typed custom field. The two
  // inputs bound each other (`max`/`min`) so a range can't invert.
  const dateFields = options.dateFields ?? [];
  function renderDateRange(
    field: { key: string; label: string },
    inputClass: string,
  ) {
    const range = filters.customDates?.[field.key] ?? {};
    return (
      <div className="flex items-center gap-1">
        <Input
          type="date"
          aria-label={`${field.label} from`}
          className={cn("h-8", inputClass)}
          value={range.from ?? ""}
          max={range.to || undefined}
          onChange={(e) => setDateRange(field.key, "from", e.target.value)}
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          aria-label={`${field.label} to`}
          className={cn("h-8", inputClass)}
          value={range.to ?? ""}
          min={range.from || undefined}
          onChange={(e) => setDateRange(field.key, "to", e.target.value)}
        />
      </div>
    );
  }

  return (
    <>
      {/* Desktop: inline filter row. */}
      <div
        className="hidden flex-wrap items-center gap-2 sm:flex"
        data-pending={pending}
      >
        {controls.map((c) => renderSelect(c, c.desktopWidth))}
        {dateFields.map((field) => (
          <div key={`cf:${field.key}`} className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            {renderDateRange(field, "w-36")}
          </div>
        ))}
        {options.canShowShipped ? (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 cursor-pointer accent-primary"
              checked={!!filters.showShipped}
              onChange={(e) =>
                set("showShipped", e.target.checked ? true : undefined)
              }
            />
            Show shipped
          </label>
        ) : null}
        {active ? (
          <Button
            variant="link"
            size="inline"
            onClick={() => update({})}
            className="text-xs font-normal text-muted-foreground underline-offset-2"
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {/* Mobile: one "Filters" button that opens a sheet with the same controls
          stacked full-width, so the row stays a single line on a phone. */}
      <div className="sm:hidden" data-pending={pending}>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="default" className="h-8 gap-2">
              <SlidersHorizontal />
              Filters
              {activeCount > 0 ? (
                <Badge variant="counter" size="sm">
                  {activeCount}
                </Badge>
              ) : null}
            </Button>
          </SheetTrigger>
          <SheetContent className="gap-5">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-4">
              {controls.map((c) => (
                <label key={c.key} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-muted-foreground">
                    {c.label}
                  </span>
                  {renderSelect(c, "h-9 w-full")}
                </label>
              ))}
              {dateFields.map((field) => (
                <div
                  key={`cf:${field.key}`}
                  className="flex flex-col gap-1.5 text-sm"
                >
                  <span className="font-medium text-muted-foreground">
                    {field.label}
                  </span>
                  {renderDateRange(field, "h-9 w-full")}
                </div>
              ))}
              {options.canShowShipped ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-primary"
                    checked={!!filters.showShipped}
                    onChange={(e) =>
                      set("showShipped", e.target.checked ? true : undefined)
                    }
                  />
                  <span className="font-medium text-muted-foreground">
                    Show shipped
                  </span>
                </label>
              ) : null}
            </div>
            {active ? (
              <Button
                variant="outline"
                onClick={() => update({})}
                className="w-full"
              >
                Clear filters
              </Button>
            ) : null}
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
