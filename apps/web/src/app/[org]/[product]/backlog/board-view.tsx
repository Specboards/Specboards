import { notFound } from "next/navigation";

import { parentLevelKey } from "@specboards/core";

import { BoardClient } from "./board-client";
import { BoardPrefsProvider } from "./board-prefs";
import { BacklogFilters, type FilterOptions } from "./backlog-filters";
import { CardFieldsMenu } from "@/components/card-fields-menu";
import { EmptyState } from "@/components/empty-state";
import { NoSpecsEmptyState } from "@/components/no-specs-empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import { WorkItemCreate } from "@/components/work-item-create";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { resolveActiveLevel } from "@/lib/active-level";
import {
  ALL_PRODUCTS,
  resolveActiveScope,
  scopeProductFilter,
} from "@/lib/active-product";
import { getBoardPreferences } from "@/lib/board-preferences-service";
import { cardFieldCatalog, resolveCardFields } from "@/lib/card-fields";
import {
  applyFeatureFilters,
  filtersToQuery,
  hasActiveFilters,
  parseFeatureFilters,
} from "@/lib/feature-filters";
import { parseSortMode } from "@/lib/feature-helpers";
import { SortControl } from "./sort-control";
import { getDb } from "@/lib/db";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import { canConnectRepos, canEditProducts, requireWorkspaceAccess } from "@/lib/workspace-access";

/**
 * Board view of the backlog: a kanban where you drag cards to reorder / change
 * status and click to edit inline. One of the two views under `/backlog`
 * (`?view=board`, the default); the table is the `list` view. See ADR 0001 (D6).
 */
export async function BoardView({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();

  const workflow = await resolveWorkflowFor(access);

  const { product: productSlug } = await params;
  const sp = await searchParams;
  const filters = parseFeatureFilters(sp);
  const sort = parseSortMode(sp.sort);
  // Board columns are the workflow statuses. A `status` filter narrows the
  // board to just that one column rather than emptying every other one.
  const allColumns = workflow.statuses.filter((s) => s !== "archived");
  const columns = filters.status
    ? allColumns.filter((s) => s === filters.status)
    : allColumns;
  const store = await getStore();
  const [allFeatures, properties, releases, detailTemplates] =
    await Promise.all([
      store.listFeatures(access ?? undefined),
      store.listProperties(access ?? undefined),
      store.listReleases(access ?? undefined),
      store.listDetailTemplates(access ?? undefined),
    ]);

  // The board scopes to the segment in the URL: one product, a product group
  // (`~key`, covering its subtree's products), or `all` = every product; it
  // shows one hierarchy level at a time (default: the leaf/specs).
  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);
  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();
  const activeProduct = scope.kind === "product" ? scope.product : null;
  // Editing is per-product now: the owner can edit anything, others need an
  // admin/contributor grant on the product (any writable product in the "all"
  // or group view). Server + RLS enforce the real boundary; this gates the
  // affordances.
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
  const scoped = allFeatures.filter((f) => inScope(f.productId));

  // When the scope spans more than one product ("All products" or a group),
  // tag each card with its owning product; scoped to one product, or when the
  // workspace only has one product, the badge carries no information, so omit.
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

  const levels = await store.listLevels(access ?? undefined);
  const activeLevel = resolveActiveLevel(levels, sp.level);
  // Cards at the active level, then narrowed by the URL filters. `featuresForLevel`
  // (pre-filter) drives the empty-state and toolbar decisions so the filter bar
  // never disappears when a filter empties the board.
  const featuresForLevel = scoped.filter((f) => f.level === activeLevel.key);
  const filtering = hasActiveFilters(filters);
  const features = filtering
    ? applyFeatureFilters(featuresForLevel, filters)
    : featuresForLevel;
  const parentKey = parentLevelKey(activeLevel.key, levels);
  const parents = parentKey
    ? scoped
        .filter((f) => f.level === parentKey)
        .map((f) => ({ specId: f.specId, title: f.title, productId: f.productId }))
    : [];
  const parentLabel =
    levels.find((l) => l.key === parentKey)?.label ?? null;
  // Seed the new-item Details editor with the active level's assigned template.
  const templateBody =
    detailTemplates.find((t) => t.id === activeLevel.detailTemplateId)?.body ??
    "";

  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const memberNames = Object.fromEntries(members.map((m) => [m.userId, m.name]));

  const prefs = await getBoardPreferences(access ?? undefined);
  const catalog = cardFieldCatalog(properties);
  const { fields: cardFields, featured } = resolveCardFields(prefs, catalog);
  const customFieldLabels = Object.fromEntries(
    properties.map((f) => [f.key, f.label]),
  );

  // Filter-bar options mirror the list view: any status (minus archived),
  // workspace assignees, and tags/epics drawn from every in-scope card so the
  // choices don't shrink as you drill into a single level.
  const filterableFeatures = scoped.filter((f) => f.status !== "archived");
  const filterOptions: FilterOptions = {
    statuses: allColumns,
    assignees: members.map((m) => ({ userId: m.userId, name: m.name })),
    tags: [...new Set(filterableFeatures.flatMap((f) => f.tags))].sort(),
    epics: filterableFeatures
      .filter((f) => f.childCount > 0)
      .map((f) => ({ specId: f.specId, title: f.title })),
    releases: releases.map((r) => ({ id: r.id, name: r.name })),
    products: productsById
      ? scopedProducts.map((p) => ({ id: p.id, name: p.name }))
      : undefined,
  };

  // The "New {level}" affordance, shared between the toolbar and the empty
  // state so a blank board offers the next step right where the user is
  // looking. Leaf items come from spec sync, so it only exists off-leaf.
  const newItemButton =
    canEdit && !activeLevel.isLeaf ? (
      <WorkItemCreate
        levelKey={activeLevel.key}
        levelLabel={activeLevel.label}
        parentLabel={parentLabel}
        parents={parents}
        productId={activeProduct?.id ?? null}
        products={scopedProducts.map((p) => ({ id: p.id, name: p.name }))}
        releases={releases
          .filter((r) => r.status !== "shipped")
          .map((r) => ({ id: r.id, name: r.name, productId: r.productId }))}
        properties={properties}
        workflow={workflow}
        members={members}
        templateBody={templateBody}
      />
    ) : null;

  return (
    <BoardPrefsProvider
      initialFields={cardFields}
      initialFeatured={featured}
      orderedKeys={catalog.map((f) => f.key)}
    >
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <WorkViewTabs />
            <LevelSwitcher levels={levels} active={activeLevel.key} />
          </div>
          <div className="flex items-center gap-2">
            {/* On an empty board the empty state carries this button instead,
                so the affordance renders exactly once. */}
            {featuresForLevel.length === 0 ? null : newItemButton}
            {featuresForLevel.length > 0 && canEdit ? (
              <CardFieldsMenu
                catalog={catalog}
                customFields={properties.map((f) => ({
                  key: f.key,
                  label: f.label,
                }))}
              />
            ) : null}
          </div>
        </div>
        {/* Filter bar: shown whenever the level has cards, so a filter that
            empties the board can still be cleared here. Same URL-driven bar as
            the list view (it preserves the `view=board` param). Sort sits at the
            row's right end, grouped with the filters rather than in the button
            toolbar, so it lines up with the other view controls. */}
        {featuresForLevel.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BacklogFilters filters={filters} options={filterOptions} />
            <SortControl sort={sort} />
          </div>
        ) : null}
        {featuresForLevel.length === 0 ? (
          activeLevel.isLeaf ? (
            <NoSpecsEmptyState canConnect={canConnectRepos(access)} />
          ) : (
            <EmptyState
              className="mt-8"
              title={`No ${activeLevel.label.toLowerCase()} items yet`}
              description={
                canEdit
                  ? `${activeLevel.label} items collect the work one level down so this board can show progress at a higher altitude. Create the first one and it appears here, ready to move through your workflow.`
                  : `${activeLevel.label} items collect the work one level down. Once someone with edit access creates one, it appears here.`
              }
              action={newItemButton}
            />
          )
        ) : features.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No items match these filters"
            description={`All ${featuresForLevel.length} ${featuresForLevel.length === 1 ? "item is" : "items are"} hidden by the current filters. Adjust or clear the filters above.`}
          />
        ) : (
          <BoardClient
            // Remount when the board's data set changes (level, product scope,
            // or active filters). BoardClient seeds drag-and-drop state from
            // `features` once on mount, so without a fresh key it would keep
            // showing the prior filter's cards.
            key={`${
              scope.kind === "product"
                ? scope.product.id
                : scope.kind === "group"
                  ? `group:${scope.group.id}`
                  : ALL_PRODUCTS
            }:${activeLevel.key}:${filtersToQuery(filters)}:${sort}`}
            features={features}
            columns={columns}
            workflow={workflow}
            sortMode={sort}
            customFieldLabels={customFieldLabels}
            memberNames={memberNames}
            releases={releases}
            productsById={productsById}
            bulkOptions={
              canEdit
                ? {
                    statuses: allColumns,
                    assignees: members.map((m) => ({
                      userId: m.userId,
                      name: m.name,
                    })),
                    releases: releases.map((r) => ({ id: r.id, name: r.name })),
                  }
                : undefined
            }
          />
        )}
      </section>
    </BoardPrefsProvider>
  );
}
