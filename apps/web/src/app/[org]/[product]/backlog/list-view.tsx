import Link from "next/link";
import { notFound } from "next/navigation";

import { childLevelKey, parentLevelKey } from "@specboards/core";

import {
  BoardSelectToggle,
  BoardSelectionProvider,
} from "@/components/board-selection";
import { EmptyState } from "@/components/empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import { NoSpecsEmptyState } from "@/components/no-specs-empty-state";
import { WorkItemCreate } from "@/components/work-item-create";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { Badge } from "@/components/ui/badge";
import { Box, BoxHeader } from "@/components/ui/box";
import { buttonVariants } from "@/components/ui/button";
import { pluralizeLevelLabel, resolveActiveLevel } from "@/lib/active-level";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
import { buildLevelRows } from "@/lib/backlog-rows";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { getDb } from "@/lib/db";
import {
  applyFeatureFilters,
  hasActiveFilters,
  hideDoneShippedItems,
  parseCustomDateFilters,
  parseFeatureFilters,
} from "@/lib/feature-filters";
import {
  compareByCustomField,
  compareByRiceScore,
  CUSTOM_SORT_PREFIX,
  parseSortMode,
  sortableProperties,
  sortFeatures,
} from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { selectableCycles, selectableReleases } from "@/lib/store/types";
import { listWorkspaceMembers } from "@/lib/workspace";
import {
  canConnectRepos,
  canEditProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";
import { BacklogFilters, type FilterOptions } from "./backlog-filters";
import { BacklogTable } from "./backlog-table";
import { SavedViews } from "./saved-views";
import { SortControl } from "./sort-control";

/**
 * List view of the backlog: a prioritized table of features. Status edits here
 * update metadata only (DB or local file) - spec content stays canonical in
 * git. A filter bar narrows the list; the active filters live in the URL query
 * string. One of the two views under `/backlog` (`?view=list`); the kanban is
 * the default `board` view. See ADR 0001 (D6).
 *
 * Like the board, the table shows one hierarchy level at a time, driven by the
 * same `?level=` param, so switching between the two views keeps your altitude.
 * The active level's items are the top-level rows, with their children from the
 * level below nested under them.
 */
export async function ListView({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const sp = await searchParams;
  const filters = parseFeatureFilters(sp);
  const store = await getStore();

  // Scope to the segment in the URL: a product, a group (`~key`), or `all`.
  const { product: productSlug } = await params;
  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);
  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();
  const activeProduct = scope.kind === "product" ? scope.product : null;
  // Transitions are per product; a group or "all" view spans products that may
  // disagree, so it shows the workspace default. Each item is still validated
  // against its own product's rules on save.
  const workflow = await resolveWorkflowFor(access, activeProduct?.id ?? null);
  // Per-product edit gate (owner edits all; others need a product grant).
  const canEdit = canEditProducts(
    access,
    products,
    scope.kind === "product"
      ? scope.product.id
      : scope.kind === "group"
        ? scope.productIds
        : null,
  );

  const inScope = scopeProductFilter(scope);
  const features = sortFeatures(await store.listFeatures(access ?? undefined))
    .filter((f) => f.status !== "archived")
    .filter((f) => inScope(f.productId));
  const [releases, cycles] = await Promise.all([
    store.listReleases(access ?? undefined),
    store.listCycles(access ?? undefined),
  ]);
  const releaseNames = Object.fromEntries(releases.map((r) => [r.id, r.name]));

  // Multi-product scope ("all" or a group): show a Product column tagging each
  // row's owner. Omitted when a single product is in context or the scope only
  // covers one product.
  const scopedProducts =
    scope.kind === "group"
      ? products.filter((p) => scope.productIds.has(p.id))
      : products;
  const productsById =
    activeProduct || scopedProducts.length <= 1
      ? undefined
      : Object.fromEntries(
          scopedProducts.map((p) => [
            p.id,
            { name: p.name, key: p.key, color: p.color },
          ]),
        );

  // Assignee options come from the workspace roster (DB mode only).
  const db = getDb();
  const members =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const savedViews = await store.listSavedViews(access ?? undefined);

  // The table shows one level at a time (same `?level=` param as the board).
  const [levels, detailTemplates] = await Promise.all([
    store.listLevels(access ?? undefined),
    store.listDetailTemplates(access ?? undefined),
  ]);
  const activeLevel = resolveActiveLevel(levels, sp.level);
  const childKey = childLevelKey(activeLevel.key, levels);
  const parentKey = parentLevelKey(activeLevel.key, levels);
  const parentLabel = levels.find((l) => l.key === parentKey)?.label ?? null;
  const parents = parentKey
    ? features
        .filter((f) => f.level === parentKey)
        .map((f) => ({
          specId: f.specId,
          title: f.title,
          productId: f.productId,
        }))
    : [];
  // Seed a new item's Details editor with the active level's template.
  const templateBody =
    detailTemplates.find((t) => t.id === activeLevel.detailTemplateId)?.body ??
    "";

  // Custom properties power both the custom-field sort options and the date
  // range filters. Date-typed fields also add a from/to range filter, parsed
  // here so it applies (and shows in the bar) alongside the built-in filters.
  const properties = await store.listProperties(access ?? undefined, "item");
  const dateProps = properties.filter((p) => p.type === "date");
  const customDates = parseCustomDateFilters(
    sp,
    dateProps.map((p) => p.key),
  );
  if (Object.keys(customDates).length > 0) filters.customDates = customDates;

  // Finished-and-shipped work is hidden by default; "Show shipped" reveals it,
  // and the toggle only appears when shipped releases exist.
  const shippedReleaseIds = new Set(
    releases.filter((r) => r.status === "shipped").map((r) => r.id),
  );

  const options: FilterOptions = {
    statuses: workflow.statuses.filter((s) => s !== "archived"),
    assignees: members.map((m) => ({ userId: m.userId, name: m.name })),
    tags: [...new Set(features.flatMap((f) => f.tags))].sort(),
    epics: features
      .filter((f) => f.childCount > 0)
      .map((f) => ({ specId: f.specId, title: f.title })),
    releases: selectableReleases(releases, filters.release ?? null).map(
      (r) => ({
        id: r.id,
        name: r.name,
      }),
    ),
    // Finished cycles drop out of the picker, except the one currently
    // filtered on, so an existing filter never disappears from its own bar.
    cycles: selectableCycles(cycles, filters.cycle ?? null).map((c) => ({
      id: c.id,
      name: c.name,
    })),
    products: productsById
      ? scopedProducts.map((p) => ({ id: p.id, name: p.name }))
      : undefined,
    dateFields: dateProps.map((p) => ({ key: p.key, label: p.label })),
    canShowShipped: shippedReleaseIds.size > 0,
  };

  // Sort options include the workspace's sortable custom properties; a `cf:`
  // sort is only honored for a key that exists (else it falls back to default).
  const sortableProps = sortableProperties(properties);
  const sort = parseSortMode(
    sp.sort,
    sortableProps.map((p) => p.key),
  );
  const customSorts = sortableProps.map((p) => ({
    value: `cf:${p.key}`,
    label: p.label,
  }));
  const customFieldTypes = Object.fromEntries(
    properties.map((p) => [p.key, p.type]),
  );
  const cfSortKey = sort.startsWith(CUSTOM_SORT_PREFIX)
    ? sort.slice(CUSTOM_SORT_PREFIX.length)
    : null;

  // Hide done-and-shipped items by default, before filtering and the hierarchy
  // grouping, so it is the standing view unless "Show shipped" is on.
  const visible = filters.showShipped
    ? features
    : hideDoneShippedItems(features, shippedReleaseIds);
  // Items at the active level, pre-filter: drives the toolbar and empty-state
  // decisions so the filter bar never vanishes when a filter empties the table.
  const featuresForLevel = features.filter((f) => f.level === activeLevel.key);
  const visibleForLevel = visible.filter((f) => f.level === activeLevel.key);
  const filtering = hasActiveFilters(filters);
  // Filtering or a value-ordered sort (RICE, custom field) flattens the view:
  // excluding arbitrary rows, or ranking by a value, both break the
  // parent->child hierarchy grouping, so only the active level's items show.
  const base = filtering
    ? applyFeatureFilters(visibleForLevel, filters)
    : visibleForLevel;
  const rows =
    sort === "rice"
      ? [...base]
          .sort(compareByRiceScore)
          .map((feature) => ({ feature, depth: 0 }))
      : cfSortKey
        ? [...base]
            .sort(
              compareByCustomField(
                cfSortKey,
                customFieldTypes[cfSortKey] ?? "text",
              ),
            )
            .map((feature) => ({ feature, depth: 0 }))
        : filtering
          ? base.map((feature) => ({ feature, depth: 0 }))
          : buildLevelRows(visible, activeLevel.key, childKey);

  // The "New {level}" affordance, shared between the toolbar and the empty
  // state so it renders exactly once. Every level is creatable, leaf included:
  // a work item with no spec is a first-class row (ADR 0003). In a multi-product
  // scope with no single product in context, the drawer's product picker
  // resolves the target.
  const newItemButton = canEdit ? (
    <WorkItemCreate
      levelKey={activeLevel.key}
      levelLabel={activeLevel.label}
      parentLabel={parentLabel}
      parents={parents}
      productId={activeProduct?.id ?? null}
      products={scopedProducts.map((p) => ({ id: p.id, name: p.name }))}
      releases={selectableReleases(releases).map((r) => ({
        id: r.id,
        name: r.name,
        productId: r.productId,
      }))}
      properties={properties}
      workflow={workflow}
      members={members}
      templateBody={templateBody}
    />
  ) : null;

  // "Clear filters" returns to this same view and level, dropping only filters.
  const clearFiltersHref = orgProductPath(
    access?.orgSlug ?? LOCAL_ORG_SLUG,
    productSlug,
    `/backlog?view=list&level=${encodeURIComponent(activeLevel.key)}`,
  );

  return (
    <BoardSelectionProvider canSelect={canEdit && rows.length > 0}>
      <section className="space-y-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <WorkViewTabs />
              <LevelSwitcher levels={levels} active={activeLevel.key} />
            </div>
            {/* One action cluster, not several stacked right-aligned rows. Every
              control here is the shared h-8 control height (see Button's
              `default` size), so the row reads as a single toolbar. */}
            <div className="flex flex-wrap items-center gap-2">
              {/* An empty level carries this button in its empty state instead. */}
              {featuresForLevel.length === 0 ? null : newItemButton}
              {featuresForLevel.length > 0 ? (
                <SortControl sort={sort} customSorts={customSorts} />
              ) : null}
              <BoardSelectToggle />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Your work items in a filterable table. Metadata edits land in the
            database; spec content stays in git.
          </p>
        </div>
        {featuresForLevel.length === 0 ? (
          activeLevel.isLeaf ? (
            <NoSpecsEmptyState
              canConnect={canConnectRepos(access)}
              createAction={newItemButton}
            />
          ) : (
            <EmptyState
              className="mt-8"
              title={`No ${activeLevel.label.toLowerCase()} items yet`}
              description={
                canEdit
                  ? `${activeLevel.label} items collect the work one level down so this table can show progress at a higher altitude. Create the first one and it appears here, ready to move through your workflow.`
                  : `${activeLevel.label} items collect the work one level down. Once someone with edit access creates one, it appears here.`
              }
              action={newItemButton}
            />
          )
        ) : (
          <>
            <BacklogFilters filters={filters} options={options} />
            <SavedViews
              views={savedViews}
              currentFilters={filters}
              canEdit={canEdit}
            />
            {rows.length === 0 ? (
              <EmptyState
                variant="inline"
                title="No items match these filters"
                description={`All ${featuresForLevel.length} ${featuresForLevel.length === 1 ? "item is" : "items are"} hidden by the current filters.`}
                action={
                  <Link
                    href={clearFiltersHref}
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                  >
                    Clear filters
                  </Link>
                }
              />
            ) : (
              <Box>
                <BoxHeader>
                  <span>{pluralizeLevelLabel(activeLevel.label)}</span>
                  <Badge variant="counter">{rows.length}</Badge>
                </BoxHeader>
                <BacklogTable
                  rows={rows}
                  canEdit={canEdit}
                  workflow={workflow}
                  productsById={productsById}
                  releaseNames={releaseNames}
                  bulkOptions={{
                    statuses: options.statuses,
                    assignees: options.assignees,
                    releases: options.releases,
                    cycles: options.cycles,
                  }}
                />
              </Box>
            )}
          </>
        )}
      </section>
    </BoardSelectionProvider>
  );
}
