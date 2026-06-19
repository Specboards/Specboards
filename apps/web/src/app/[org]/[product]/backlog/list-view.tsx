import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { ALL_PRODUCTS, resolveActiveProduct } from "@/lib/active-product";
import { getDb } from "@/lib/db";
import {
  applyFeatureFilters,
  hasActiveFilters,
  parseFeatureFilters,
} from "@/lib/feature-filters";
import { sortFeatures } from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { canWrite, listWorkspaceMembers } from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";
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
  const canEdit = !access || canWrite(access.role);
  const workflow = await resolveWorkflowFor(access);
  const filters = parseFeatureFilters(await searchParams);
  const store = await getStore();

  // Scope to the product in the URL (`all` = every product).
  const { product: productSlug } = await params;
  const products = await store.listProducts(access ?? undefined);
  const activeProduct = resolveActiveProduct(products, productSlug);
  if (productSlug !== ALL_PRODUCTS && !activeProduct) notFound();

  const features = sortFeatures(await store.listFeatures(access ?? undefined))
    .filter((f) => f.status !== "archived")
    .filter((f) => !activeProduct || f.productId === activeProduct.id);

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
    priorities: [0, 1, 2, 3, 4],
  };

  const filtering = hasActiveFilters(filters);
  const rows = filtering
    ? // Filtering flattens the view — the hierarchy grouping no longer holds
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
          Prioritized features. Metadata edits land in the database; spec
          content stays in git.
        </p>
      </div>
      {features.length === 0 ? (
        <EmptyState canConnect={canConnectRepos(access)} />
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
              No features match these filters.
            </p>
          ) : (
            <BacklogTable rows={rows} canEdit={canEdit} workflow={workflow} />
          )}
        </>
      )}
    </section>
  );
}

/** Order rows as a hierarchy: each top-level feature followed by its children. */
function buildHierarchyRows<T extends { specId: string; parentSpecId: string | null }>(
  features: T[],
): { feature: T; depth: number }[] {
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
