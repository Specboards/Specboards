import { notFound } from "next/navigation";

import { parentLevelKey } from "@specboard/core";

import { BoardClient } from "./board-client";
import { BoardPrefsProvider } from "./board-prefs";
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
  const columns = workflow.statuses.filter((s) => s !== "archived");

  const { product: productSlug } = await params;
  const sp = await searchParams;
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
  const features = scoped.filter((f) => f.level === activeLevel.key);
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
            {features.length === 0 ? null : newItemButton}
            {features.length > 0 && canEdit ? (
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
        {features.length === 0 ? (
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
        ) : (
          <BoardClient
            // Remount when the board's data set changes (level or product scope).
            // BoardClient seeds drag-and-drop state from `features` once on mount,
            // so without a fresh key it would keep showing the prior level's cards.
            key={`${
              scope.kind === "product"
                ? scope.product.id
                : scope.kind === "group"
                  ? `group:${scope.group.id}`
                  : ALL_PRODUCTS
            }:${activeLevel.key}`}
            features={features}
            columns={columns}
            workflow={workflow}
            customFieldLabels={customFieldLabels}
            memberNames={memberNames}
            releases={releases}
            productsById={productsById}
          />
        )}
      </section>
    </BoardPrefsProvider>
  );
}
