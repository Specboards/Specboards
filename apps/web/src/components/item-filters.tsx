"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition, type KeyboardEvent, type ReactNode } from "react";

import { ChevronDown, ListFilter, Plus, X } from "lucide-react";

import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { withViewParams } from "@/lib/backlog-query";
import { statusLabel } from "@/lib/feature-helpers";
import {
  clearFilterKey,
  countActiveFilters,
  filtersToQuery,
  hasActiveFilters,
  toggleFilterValue,
  type FeatureFilters,
  type FilterKey,
} from "@/lib/feature-filters";
import { cn } from "@/lib/utils";

export interface FilterOptions {
  statuses: string[];
  assignees: { userId: string; name: string }[];
  tags: string[];
  epics: { specId: string; title: string }[];
  releases: { id: string; name: string }[];
  /** Cycles to filter by; a second axis alongside releases, so both can be set
   * at once and each narrows independently. */
  cycles?: { id: string; name: string }[];
  /** Products to filter by; provided only in the cross-product view. */
  products?: { id: string; name: string }[];
  /** Date-typed custom fields, each offering a from/to range filter. */
  dateFields?: { key: string; label: string }[];
  /** Whether to offer the "Show shipped" toggle (any shipped release exists). */
  canShowShipped?: boolean;
}

/** One filter dimension, resolved against the current data set. */
interface FilterControl {
  key: FilterKey;
  /** Short noun used as the chip's and the menu's field label. */
  label: string;
  /** The values currently accepted; empty when this dimension is not filtered. */
  values: string[];
  /** Sentinel options (e.g. "Unassigned") offered before the real values. */
  leading?: { value: string; label: string }[];
  options: { value: string; label: string }[];
}

/**
 * Build the filter dimensions this data set can actually offer, in the order
 * they are presented. A dimension with nothing to choose from is left out
 * rather than rendered empty: a board in a workspace with no cycles should not
 * be offered a cycle filter at all.
 */
function buildControls(
  filters: FeatureFilters,
  options: FilterOptions,
): FilterControl[] {
  const controls: FilterControl[] = [];
  if (options.products && options.products.length > 0) {
    controls.push({
      key: "product",
      label: "Product",
      values: filters.product ?? [],
      options: options.products.map((p) => ({ value: p.id, label: p.name })),
    });
  }
  if (options.statuses.length > 0) {
    controls.push({
      key: "status",
      label: "Status",
      values: filters.status ?? [],
      options: options.statuses.map((s) => ({
        value: s,
        label: statusLabel(s),
      })),
    });
  }
  if (options.assignees.length > 0) {
    controls.push({
      key: "assignee",
      label: "Assignee",
      values: filters.assignee ?? [],
      leading: [{ value: "unassigned", label: "Unassigned" }],
      options: options.assignees.map((a) => ({
        value: a.userId,
        label: a.name,
      })),
    });
  }
  if (options.releases.length > 0) {
    controls.push({
      key: "release",
      label: "Release",
      values: filters.release ?? [],
      leading: [{ value: "none", label: "No release" }],
      options: options.releases.map((r) => ({ value: r.id, label: r.name })),
    });
  }
  if (options.cycles && options.cycles.length > 0) {
    controls.push({
      key: "cycle",
      label: "Cycle",
      values: filters.cycle ?? [],
      leading: [{ value: "none", label: "No cycle" }],
      options: options.cycles.map((c) => ({ value: c.id, label: c.name })),
    });
  }
  if (options.tags.length > 0) {
    controls.push({
      key: "tag",
      label: "Tag",
      values: filters.tag ?? [],
      options: options.tags.map((t) => ({ value: t, label: t })),
    });
  }
  if (options.epics.length > 0) {
    controls.push({
      key: "parent",
      label: "Parent",
      values: filters.parent ?? [],
      leading: [{ value: "none", label: "Top-level only" }],
      options: options.epics.map((ep) => ({
        value: ep.specId,
        label: ep.title,
      })),
    });
  }
  return controls;
}

/**
 * What a chip prints for the values a dimension accepts.
 *
 * One value reads as itself. Several read as the first plus a count rather than
 * a comma list, because the alternative is a chip that grows without bound and
 * pushes the rest of the bar off the row; the full set is one click away in the
 * chip's own menu, with a check beside each.
 */
function valuesLabel(control: FilterControl): string {
  const all = [...(control.leading ?? []), ...control.options];
  const labelFor = (v: string) => all.find((o) => o.value === v)?.label ?? v;
  const [head, ...rest] = control.values;
  if (head === undefined) return "any";
  return rest.length === 0
    ? labelFor(head)
    : `${labelFor(head)} +${rest.length}`;
}

/** A date range rendered for a chip: "from – to", or one open end. */
function rangeLabel(range: { from?: string; to?: string }): string {
  if (range.from && range.to) return `${range.from} to ${range.to}`;
  if (range.from) return `from ${range.from}`;
  if (range.to) return `to ${range.to}`;
  return "any";
}

/**
 * Everything a filter control needs to change the URL. The active filters live
 * in the query string (parsed server-side), so a filtered view is shareable and
 * survives a refresh, and neither the menu nor the bar holds filter state.
 */
function useFilterNav(filters: FeatureFilters) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(next: FeatureFilters) {
    // Rebuild the query from the filters, carrying over the params that shape
    // the view itself (view, level, sort) so changing or clearing a filter
    // doesn't bounce the user back to the board at the default level.
    const query = withViewParams(filtersToQuery(next), searchParams);
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  }

  /** Add or remove one accepted value in a dimension. */
  function toggle(key: FilterKey, value: string) {
    update(toggleFilterValue(filters, key, value));
  }

  /** Drop a whole dimension, chip and all. */
  function clearKey(key: FilterKey) {
    update(clearFilterKey(filters, key));
  }

  /** The shipped toggle, which is a view switch rather than a dimension. */
  function setShowShipped(on: boolean) {
    const next = { ...filters };
    if (on) next.showShipped = true;
    else delete next.showShipped;
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

  /** Drop one date field's range entirely (the chip's "Remove"). */
  function clearDateField(fieldKey: string) {
    const customDates = { ...filters.customDates };
    delete customDates[fieldKey];
    const next = { ...filters };
    if (Object.keys(customDates).length) next.customDates = customDates;
    else delete next.customDates;
    update(next);
  }

  return {
    pending,
    update,
    toggle,
    clearKey,
    setShowShipped,
    setDateRange,
    clearDateField,
  };
}

type FilterNav = ReturnType<typeof useFilterNav>;

/** The two date inputs for one range, used inside a menu rather than in a row. */
function DateRangeFields({
  field,
  range,
  nav,
}: {
  field: { key: string; label: string };
  range: { from?: string; to?: string };
  nav: FilterNav;
}) {
  // A menu runs typeahead on printable keys and closes on Enter, both of which
  // would fight a date input sitting inside it. Stopping the keyboard at the
  // input leaves Escape (handled on the menu content) as the only key the menu
  // still sees, so the range is typeable and the menu is still dismissable.
  const keepKeysOffTheMenu = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") e.stopPropagation();
  };
  return (
    <div className="flex flex-col gap-2 p-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <Input
          type="date"
          aria-label={`${field.label} from`}
          className="h-8 w-44"
          value={range.from ?? ""}
          max={range.to || undefined}
          onKeyDown={keepKeysOffTheMenu}
          onChange={(e) => nav.setDateRange(field.key, "from", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <Input
          type="date"
          aria-label={`${field.label} to`}
          className="h-8 w-44"
          value={range.to ?? ""}
          min={range.from || undefined}
          onKeyDown={keepKeysOffTheMenu}
          onChange={(e) => nav.setDateRange(field.key, "to", e.target.value)}
        />
      </label>
    </div>
  );
}

/** The menu body shared by the toolbar button and the bar's "Add filter". */
function AddFilterItems({
  filters,
  options,
  controls,
  nav,
}: {
  filters: FeatureFilters;
  options: FilterOptions;
  controls: FilterControl[];
  nav: FilterNav;
}) {
  // Only dimensions with nothing chosen yet. A dimension that already has a
  // chip is widened from that chip, where its current values are visible with
  // a check beside each; offering it a second time here would be two places to
  // change one filter, disagreeing about what is already set.
  const unsetControls = controls.filter((c) => c.values.length === 0);
  const unsetDateFields = (options.dateFields ?? []).filter(
    (f) => !filters.customDates?.[f.key],
  );
  const canToggleShipped = !!options.canShowShipped && !filters.showShipped;
  const nothingLeft =
    unsetControls.length === 0 &&
    unsetDateFields.length === 0 &&
    !canToggleShipped;

  if (nothingLeft) {
    return (
      <DropdownMenuItem disabled>Every filter is already set</DropdownMenuItem>
    );
  }

  return (
    <>
      {unsetControls.map((control) => (
        <DropdownMenuSub key={control.key}>
          <DropdownMenuSubTrigger>{control.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 max-w-[18rem] overflow-y-auto">
            {[...(control.leading ?? []), ...control.options].map((o) => (
              // Closes the menu on pick, unlike the chip's rows below. This one
              // is the gesture "add a filter", and it is finished; widening it
              // to several values is the chip's job, and the chip is now on
              // screen to say so.
              <DropdownMenuItem
                key={o.value}
                onSelect={() => nav.toggle(control.key, o.value)}
              >
                <span className="truncate">{o.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      {unsetDateFields.map((field) => (
        <DropdownMenuSub key={`cf:${field.key}`}>
          <DropdownMenuSubTrigger>{field.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DateRangeFields field={field} range={{}} nav={nav} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      {canToggleShipped ? (
        <>
          {unsetControls.length > 0 || unsetDateFields.length > 0 ? (
            <DropdownMenuSeparator />
          ) : null}
          <DropdownMenuItem onSelect={() => nav.setShowShipped(true)}>
            Show shipped work
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The toolbar's filter affordance: one button that opens a menu of every field
 * this view can filter by, each leading to its values.
 *
 * This replaces a row of always-visible "Any status" / "Any assignee" selects.
 * That row grew with the workspace - every release, cycle, tag and date-typed
 * custom property added one more empty control above the board - and in the
 * common case, where nothing is being filtered, every one of them was a control
 * doing nothing. Same instinct as "Add" starting as an affordance rather than
 * an open form: a control on screen is a claim the user has something to set.
 *
 * Pair with {@link ItemFilterBar}, which renders the filters that *are* set.
 */
export function ItemFilterMenu({
  filters,
  options,
}: {
  filters: FeatureFilters;
  options: FilterOptions;
}) {
  const nav = useFilterNav(filters);
  const controls = buildControls(filters, options);
  const activeCount = countActiveFilters(filters);

  if (controls.length === 0 && (options.dateFields ?? []).length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={cn("gap-1.5", activeCount > 0 && "text-link")}
                aria-label="Filter"
                data-pending={nav.pending}
              >
                <ListFilter />
                {activeCount > 0 ? (
                  // A span, not <Badge>: that renders a div, and a div inside a
                  // <button> is not valid phrasing content.
                  <span
                    className={badgeVariants({
                      variant: "counter",
                      size: "sm",
                    })}
                  >
                    {activeCount}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Filter</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuLabel>Filter by</DropdownMenuLabel>
        <AddFilterItems
          filters={filters}
          options={options}
          controls={controls}
          nav={nav}
        />
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => nav.update({})}>
              Clear all filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The chip look: a soft, link-coloured pill, so a set filter reads as something
 * deliberately turned on rather than as another toolbar control.
 */
const CHIP =
  "inline-flex h-7 items-center gap-1 rounded-md border border-link/40 bg-link/10 px-2 text-xs font-medium text-link transition-colors hover:bg-link/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * One filter chip: reads as "Label: Value", opens to widen, narrow or remove it.
 *
 * `hint` names what the menu does when a dimension takes several values, since
 * a list of checkboxes does not say on its own whether ticking a second one
 * narrows the result or widens it. Here it widens: the values are OR'd.
 */
function FilterChip({
  label,
  value,
  hint,
  children,
  onRemove,
}: {
  label: string;
  value: string;
  hint?: string;
  children: ReactNode;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(CHIP, "max-w-[16rem]")}>
          <span className="shrink-0 opacity-80">{label}:</span>
          <span className="truncate">{value}</span>
          <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[18rem]">
        <DropdownMenuLabel>{hint ?? label}</DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">{children}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onRemove}
          className="text-muted-foreground focus:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
          Remove filter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The filters that are currently set, as removable chips, plus an "Add filter"
 * affordance. Renders nothing at all when nothing is filtered, which is the
 * point: the board's own toolbar is then the only thing above the cards.
 *
 * Pair with {@link ItemFilterMenu} in the toolbar, which is how the first
 * filter gets added.
 */
export function ItemFilterBar({
  filters,
  options,
}: {
  filters: FeatureFilters;
  options: FilterOptions;
}) {
  const nav = useFilterNav(filters);
  const controls = buildControls(filters, options);
  const setControls = controls.filter((c) => c.values.length > 0);
  const dateFields = options.dateFields ?? [];
  const setDateFields = dateFields.filter((f) => filters.customDates?.[f.key]);
  const active = hasActiveFilters(filters);

  // Nothing set: no row, no empty controls, no "Add filter" sitting on its own.
  // The toolbar's filter button is the way in, so this stays out of the way.
  if (!active && !filters.showShipped) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-pending={nav.pending}
    >
      {setControls.map((control) => (
        <FilterChip
          key={control.key}
          label={control.label}
          value={valuesLabel(control)}
          hint={`${control.label} is any of`}
          onRemove={() => nav.clearKey(control.key)}
        >
          {[...(control.leading ?? []), ...control.options].map((o) => (
            <DropdownMenuCheckItem
              key={o.value}
              checked={control.values.includes(o.value)}
              // Keep the menu open: ticking several values is one thought, and
              // reopening the chip between each would make widening a filter
              // cost as many round trips as it has values. Unticking the last
              // one drops the dimension and closes with the chip.
              onSelect={(e) => {
                if (
                  control.values.length > 1 ||
                  !control.values.includes(o.value)
                ) {
                  e.preventDefault();
                }
                nav.toggle(control.key, o.value);
              }}
            >
              <span className="truncate">{o.label}</span>
            </DropdownMenuCheckItem>
          ))}
        </FilterChip>
      ))}

      {setDateFields.map((field) => (
        <FilterChip
          key={`cf:${field.key}`}
          label={field.label}
          value={rangeLabel(filters.customDates?.[field.key] ?? {})}
          onRemove={() => nav.clearDateField(field.key)}
        >
          <DateRangeFields
            field={field}
            range={filters.customDates?.[field.key] ?? {}}
            nav={nav}
          />
        </FilterChip>
      ))}

      {filters.showShipped ? (
        <button
          type="button"
          onClick={() => nav.setShowShipped(false)}
          className={CHIP}
        >
          Shipped work shown
          <X className="size-3 shrink-0 opacity-70" aria-hidden />
        </button>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-muted-foreground"
          >
            <Plus className="size-3.5" />
            Filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem]">
          <AddFilterItems
            filters={filters}
            options={options}
            controls={controls}
            nav={nav}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {active ? (
        <Button
          variant="link"
          size="inline"
          onClick={() => nav.update({})}
          className="ml-1 text-xs font-normal text-muted-foreground underline-offset-2"
        >
          Clear all
        </Button>
      ) : null}
    </div>
  );
}
