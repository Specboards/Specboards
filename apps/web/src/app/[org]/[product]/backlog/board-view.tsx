import { notFound } from "next/navigation";

import { parentLevelKey } from "@specboards/core";

import { BoardClient } from "./board-client";
import { BoardPrefsProvider } from "./board-prefs";
import { BacklogFilters, type FilterOptions } from "./backlog-filters";
import {
  BoardSelectToggle,
  BoardSelectionProvider,
} from "@/components/board-selection";
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
  scopeProductIds,
} from "@/lib/active-product";
import { getBoardPreferences } from "@/lib/board-preferences-service";
import { cardFieldCatalog, resolveCardFields } from "@/lib/card-fields";
import {
  applyFeatureFilters,
  filtersToQuery,
  hasActiveFilters,
  hideDoneShippedItems,
  parseCustomDateFilters,
  parseFeatureFilters,
} from "@/lib/feature-filters";
import { parseSortMode, sortableProperties } from "@/lib/feature-helpers";
import { SortControl } from "./sort-control";
import { getDb } from "@/lib/db";
import { resolveWorkflowForProducts } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { selectableCycles, selectableReleases } from "@/lib/store/types";
import { listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import {
  canConnectRepos,
  canEditProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";

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

  const { product: productSlug } = await params;
  const sp = await searchParams;
  const filters = parseFeatureFilters(sp);
  const store = await getStore();
  const [allFeatures, properties, releases, cycles, detailTemplates] =
    await Promise.all([
      store.listFeatures(access ?? undefined),
      store.listProperties(access ?? undefined, "item"),
      store.listReleases(access ?? undefined),
      store.listCycles(access ?? undefined),
      store.listDetailTemplates(access ?? undefined),
    ]);

  // Date-typed custom fields add a from/to range filter; parse those params now
  // so the range is applied (and reflected in the bar) alongside the built-ins.
  const dateProps = properties.filter((p) => p.type === "date");
  const customDates = parseCustomDateFilters(
    sp,
    dateProps.map((p) => p.key),
  );
  if (Object.keys(customDates).length > 0) filters.customDates = customDates;

  // Finished-and-shipped work is hidden from the everyday board unless the user
  // opts in via "Show shipped"; the toggle only appears when shipped releases
  // exist to reveal.
  const shippedReleaseIds = new Set(
    releases.filter((r) => r.status === "shipped").map((r) => r.id),
  );

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

  // Stages and transitions are both per product now, so the board has to know
  // which products it is showing before it can draw its columns. A group or
  // "all" view takes the union of their stages, so no item is left without a
  // column; each card is still validated against its own product's rules when
  // it actually moves.
  const workflow = await resolveWorkflowForProducts(
    access,
    scopeProductIds(scope),
  );
  // Board columns are the workflow statuses. A `status` filter narrows the
  // board to just that one column rather than emptying every other one.
  const allColumns = workflow.statuses.filter((s) => s !== "archived");
  const columns = filters.status
    ? allColumns.filter((s) => s === filters.status)
    : allColumns;
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
  // Hide done-and-shipped items by default (before the user filters), so the
  // toolbar/empty-state still see the level's real card count via
  // `featuresForLevel` and the filter bar never vanishes.
  const visibleForLevel = filters.showShipped
    ? featuresForLevel
    : hideDoneShippedItems(featuresForLevel, shippedReleaseIds);
  const filtering = hasActiveFilters(filters);
  const features = filtering
    ? applyFeatureFilters(visibleForLevel, filters)
    : visibleForLevel;
  const parentKey = parentLevelKey(activeLevel.key, levels);
  const parents = parentKey
    ? scoped
        .filter((f) => f.level === parentKey)
        .map((f) => ({
          specId: f.specId,
          title: f.title,
          productId: f.productId,
        }))
    : [];
  const parentLabel = levels.find((l) => l.key === parentKey)?.label ?? null;
  // Seed the new-item Details editor with the active level's assigned template.
  const templateBody =
    detailTemplates.find((t) => t.id === activeLevel.detailTemplateId)?.body ??
    "";

  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const memberNames = Object.fromEntries(
    members.map((m) => [m.userId, m.name]),
  );

  const prefs = await getBoardPreferences(access ?? undefined);
  const catalog = cardFieldCatalog(properties);
  const { fields: cardFields, featured } = resolveCardFields(prefs, catalog);
  const customFieldLabels = Object.fromEntries(
    properties.map((f) => [f.key, f.label]),
  );

  // Sort options include the workspace's sortable custom properties, so a
  // board can be ordered by e.g. a "Due date" date field. Parsed here (not up
  // top) because a `cf:` sort is only honored for a key that actually exists.
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

  // The "New {level}" affordance, shared between the toolbar and the empty
  // state so a blank board offers the next step right where the user is
  // looking. Leaf items come from spec sync, so it only exists off-leaf.
  // The per-column quick add needs a single product to create into. Use the
  // product in scope, or the sole product when the view spans "all"/a group but
  // the workspace has just one. Spanning several products, there's no unambiguous
  // target, so the column quick add stays off and creation goes through the
  // drawer's product picker instead.
  const quickAddProductId =
    activeProduct?.id ??
    (scopedProducts.length === 1 ? (scopedProducts[0]?.id ?? null) : null);
  // Every level is creatable, leaf included: a work item with no spec is a
  // first-class row (ADR 0003), so the quick add is gated on edit access and an
  // unambiguous product, not on altitude.
  const quickAdd =
    canEdit && quickAddProductId
      ? {
          levelKey: activeLevel.key,
          levelLabel: activeLevel.label,
          productId: quickAddProductId,
        }
      : undefined;

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

  return (
    <BoardPrefsProvider
      initialFields={cardFields}
      initialFeatured={featured}
      orderedKeys={catalog.map((f) => f.key)}
    >
      <BoardSelectionProvider canSelect={canEdit && features.length > 0}>
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <WorkViewTabs />
              <LevelSwitcher levels={levels} active={activeLevel.key} />
            </div>
            {/* One action cluster, not three stacked right-aligned rows. Every
              control in here is the shared h-8 control height (see Button's
              `default` size), so the row reads as a single toolbar. */}
            <div className="flex flex-wrap items-center gap-2">
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
              {featuresForLevel.length > 0 ? (
                <SortControl sort={sort} customSorts={customSorts} />
              ) : null}
              <BoardSelectToggle />
            </div>
          </div>
          {/* Filter bar: shown whenever the level has cards, so a filter that
            empties the board can still be cleared here. Same URL-driven bar as
            the list view (it preserves the `view=board` param). It gets its own
            full-width row because the set of filters grows with the workspace's
            custom properties. */}
          {featuresForLevel.length > 0 ? (
            <BacklogFilters filters={filters} options={filterOptions} />
          ) : null}
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
              customFieldTypes={customFieldTypes}
              customFieldLabels={customFieldLabels}
              memberNames={memberNames}
              releases={releases}
              productsById={productsById}
              quickAdd={quickAdd}
              bulkOptions={
                canEdit
                  ? {
                      statuses: allColumns,
                      assignees: members.map((m) => ({
                        userId: m.userId,
                        name: m.name,
                      })),
                      releases: selectableReleases(releases).map((r) => ({
                        id: r.id,
                        name: r.name,
                      })),
                      cycles: selectableCycles(cycles, null).map((c) => ({
                        id: c.id,
                        name: c.name,
                      })),
                    }
                  : undefined
              }
            />
          )}
        </section>
      </BoardSelectionProvider>
    </BoardPrefsProvider>
  );
}
