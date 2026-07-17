import { notFound } from "next/navigation";

import { NoSpecsEmptyState } from "@/components/empty-state";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { Badge } from "@/components/ui/badge";
import { Box, BoxHeader } from "@/components/ui/box";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
import { getDb } from "@/lib/db";
import {
  applyFeatureFilters,
  hasActiveFilters,
  parseFeatureFilters,
} from "@/lib/feature-filters";
import { sortFeatures } from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { listWorkspaceMembers } from "@/lib/workspace";
import {
  canConnectRepos,
  canEditProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";
import { BacklogFilters, type FilterOptions } from "./backlog-filters";
import { BacklogTable } from "./backlog-table";
import { SavedViews } from "./saved-views";

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
  const filters = parseFeatureFilters(await searchParams);
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

  const options: FilterOptions = {
    statuses: workflow.statuses.filter((s) => s !== "archived"),
    assignees: members.map((m) => ({ userId: m.userId, name: m.name })),
    tags: [...new Set(features.flatMap((f) => f.tags))].sort(),
    epics: features
      .filter((f) => f.childCount > 0)
      .map((f) => ({ specId: f.specId, title: f.title })),
    releases: releases.map((r) => ({ id: r.id, name: r.name })),
    products: productsById
      ? scopedProducts.map((p) => ({ id: p.id, name: p.name }))
      : undefined,
  };

  const filtering = hasActiveFilters(filters);
  const rows = filtering
    ? // Filtering flattens the view, so the hierarchy grouping no longer holds
      // once arbitrary rows are excluded.
      applyFeatureFilters(features, filters).map((feature) => ({
        feature,
        depth: 0,
      }))
    : buildHierarchyRows(features);

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
          <BacklogFilters filters={filters} options={options} />
          <SavedViews
            views={savedViews}
            currentFilters={filters}
            canEdit={canEdit}
          />
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No features match these filters. Use Clear filters above to see
              everything.
            </p>
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
