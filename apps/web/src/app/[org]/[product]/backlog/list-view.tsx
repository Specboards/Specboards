import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { NoSpecsEmptyState } from "@/components/no-specs-empty-state";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { Badge } from "@/components/ui/badge";
import { Box, BoxHeader } from "@/components/ui/box";
import { buttonVariants } from "@/components/ui/button";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
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
import { selectableReleases } from "@/lib/store/types";
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
 * update metadata only (DB or local file) — spec content stays canonical in
 * git. A filter bar narrows the list; the active filters live in the URL query
 * string. One of the two views under `/backlog` (`?view=list`); the kanban is
 * the default `board` view. See ADR 0001 (D6).
 */
export async function ListView({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const workflow = await resolveWorkflowFor(access);
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
  const releases = await store.listReleases(access ?? undefined);
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

  // Custom properties power both the custom-field sort options and the date
  // range filters. Date-typed fields also add a from/to range filter, parsed
  // here so it applies (and shows in the bar) alongside the built-in filters.
  const properties = await store.listProperties(access ?? undefined);
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
    releases: selectableReleases(releases, filters.release ?? null).map((r) => ({
      id: r.id,
      name: r.name,
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
  const filtering = hasActiveFilters(filters);
  // Filtering or a value-ordered sort (RICE, custom field) flattens the view:
  // excluding arbitrary rows, or ranking by a value, both break the
  // parent→child hierarchy grouping.
  const base = filtering ? applyFeatureFilters(visible, filters) : visible;
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
          : buildHierarchyRows(visible);

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <WorkViewTabs />
        <p className="text-sm text-muted-foreground">
          Your work items in a filterable table. Metadata edits land in the
          database; spec content stays in git.
        </p>
      </div>
      {features.length === 0 ? (
        <NoSpecsEmptyState canConnect={canConnectRepos(access)} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BacklogFilters filters={filters} options={options} />
            <SortControl sort={sort} customSorts={customSorts} />
          </div>
          <SavedViews
            views={savedViews}
            currentFilters={filters}
            canEdit={canEdit}
          />
          {rows.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No features match these filters"
              description={`All ${features.length} ${features.length === 1 ? "item is" : "items are"} hidden by the current filters.`}
              action={
                <Link
                  href={orgProductPath(
                    access?.orgSlug ?? LOCAL_ORG_SLUG,
                    productSlug,
                    "/backlog?view=list",
                  )}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Clear filters
                </Link>
              }
            />
          ) : (
            <Box>
              <BoxHeader>
                <span>Features</span>
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
                }}
              />
            </Box>
          )}
        </>
      )}
    </section>
  );
}

/** Order rows as a hierarchy: each top-level feature followed by its children. */
function buildHierarchyRows<
  T extends { specId: string; parentSpecId: string | null },
>(features: T[]): { feature: T; depth: number }[] {
  const bySpec = new Map(features.map((f) => [f.specId, f]));
  const childrenOf = new Map<string, T[]>();
  const topLevel: T[] = [];
  for (const f of features) {
    const parent = f.parentSpecId ? bySpec.get(f.parentSpecId) : undefined;
    if (parent) {
      const arr = childrenOf.get(parent.specId) ?? [];
      arr.push(f);
      childrenOf.set(parent.specId, arr);
    } else {
      topLevel.push(f);
    }
  }
  const rows: { feature: T; depth: number }[] = [];
  for (const f of topLevel) {
    rows.push({ feature: f, depth: 0 });
    for (const c of childrenOf.get(f.specId) ?? [])
      rows.push({ feature: c, depth: 1 });
  }
  return rows;
}
