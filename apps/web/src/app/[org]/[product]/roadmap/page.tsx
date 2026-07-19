import Link from "next/link";
import { notFound } from "next/navigation";

import { parentLevelKey } from "@specboard/core";

import { BoardPrefsProvider } from "@/app/[org]/[product]/backlog/board-prefs";
import { CardFieldsMenu } from "@/components/card-fields-menu";
import { EmptyState } from "@/components/empty-state";
import { NoSpecsEmptyState } from "@/components/no-specs-empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import { ReleaseCreate } from "@/components/release-controls";
import { WorkItemCreate } from "@/components/work-item-create";
import { resolveActiveLevel } from "@/lib/active-level";
import {
  ALL_PRODUCTS,
  resolveActiveScope,
  scopeProductFilter,
} from "@/lib/active-product";
import { getBoardPreferences } from "@/lib/board-preferences-service";
import { cardFieldCatalog, resolveCardFields } from "@/lib/card-fields";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { sortFeatures } from "@/lib/feature-helpers";
import { getDb } from "@/lib/db";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import {
  canConnectRepos,
  canEditProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";
import { RoadmapBoard, type RoadmapColumn } from "./roadmap-board";

export const dynamic = "force-dynamic";

/** Roadmap: items grouped by release (dated first), unscheduled work last. */
export default async function RoadmapPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  // Portfolio (no-product) releases are owner-only (`isAdmin`); product releases
  // are managed by that product's admins/contributors (per-release `canEdit`
  // computed once products load).
  const isAdmin = !access || access.role === "owner";
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const sp = await searchParams;
  const store = await getStore();
  const allFeatures = sortFeatures(
    await store.listFeatures(access ?? undefined),
  ).filter((f) => f.status !== "archived");
  const releases = await store.listReleases(access ?? undefined);
  const detailTemplates = await store.listDetailTemplates(access ?? undefined);
  const properties = await store.listProperties(access ?? undefined);

  // Card creation needs the workspace status workflow (first status is the
  // default) and the assignable members.
  const workflow = await resolveWorkflowFor(access);
  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];

  // Card-field display prefs are kept per space, so the Roadmap remembers its
  // own selection separate from the Backlog (board = "roadmap"). The label maps
  // let the card turn field keys into readable badges.
  const prefs = await getBoardPreferences(access ?? undefined, "roadmap");
  const catalog = cardFieldCatalog(properties);
  const { fields: cardFields, featured } = resolveCardFields(prefs, catalog);
  const customFieldLabels = Object.fromEntries(
    properties.map((p) => [p.key, p.label]),
  );
  const memberNames = Object.fromEntries(
    members.map((m) => [m.userId, m.name]),
  );
  const releaseNames = Object.fromEntries(releases.map((r) => [r.id, r.name]));

  // Roadmap scopes to the segment in the URL (a product, a `~key` group, or
  // `all` = every product) and shows one hierarchy level at a time (default:
  // the Feature altitude).
  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);
  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();
  const activeProduct = scope.kind === "product" ? scope.product : null;
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

  // Multi-product scope ("all" or a group): tag each card with its owning
  // product. Skipped when a single product is in context or the scope only
  // covers one product (the tag carries no information then).
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

  // Releases are per-product: a product roadmap shows that product's releases
  // plus workspace-wide (portfolio) releases; a group scope shows its products'
  // releases plus portfolio; the "all" scope shows every release.
  const scopedReleases = releases.filter((r) => {
    if (r.productId === null) return true; // portfolio releases apply everywhere
    if (scope.kind === "product") return r.productId === scope.product.id;
    if (scope.kind === "group") return scope.productIds.has(r.productId);
    return true;
  });

  // Per-release edit permission: a portfolio release needs the workspace owner;
  // a product release needs admin/contributor on that product. The store
  // enforces the same rule; this just decides which controls to render.
  const editableReleaseIds = scopedReleases
    .filter((r) =>
      r.productId === null
        ? isAdmin
        : canEditProducts(access, products, r.productId),
    )
    .map((r) => r.id);
  const productNamesById = Object.fromEntries(
    products.map((p) => [p.id, p.name]),
  );

  // Shipped releases (and their items) leave the active roadmap and live under a
  // separate "Shipped releases" view (?view=shipped). Split the set so each view
  // only builds its own columns.
  const showShipped = sp.view === "shipped";
  const activeReleases = scopedReleases.filter((r) => r.status !== "shipped");
  const shippedReleases = scopedReleases.filter((r) => r.status === "shipped");
  const visibleReleases = showShipped ? shippedReleases : activeReleases;

  // One column per release (already ordered: dated first), Unscheduled last.
  // Editors always get the Unscheduled column (active view) as a drop target for
  // clearing an item's release; read-only viewers see it only when something is
  // actually unscheduled, so a fully-planned board stays tidy.
  const includeUnscheduled =
    !showShipped && (canEdit || features.some((f) => f.releaseId === null));
  const columns: RoadmapColumn[] = [
    ...visibleReleases.map((r) => ({
      releaseId: r.id as string | null,
      name: r.name,
      startDate: r.startDate,
      targetDate: r.targetDate,
      status: r.status as string | null,
      release: r,
    })),
    ...(includeUnscheduled
      ? [
          {
            releaseId: null,
            name: "Unscheduled",
            startDate: null,
            targetDate: null,
            status: null,
            release: null,
          },
        ]
      : []),
  ];

  // Creation affordances. When a page-level empty state is showing, it takes
  // over the relevant button so the next step sits where the user is looking;
  // the toolbar hides its twin so each affordance renders exactly once.
  const itemCtaInEmptyState =
    features.length === 0 && !activeLevel.isLeaf && !showShipped;
  const releaseCtaInEmptyState =
    itemCtaInEmptyState && scopedReleases.length === 0;
  // A product roadmap creates a release for that product (admins/contributors);
  // the aggregate roadmap creates a portfolio release (owner only).
  const canCreateRelease = activeProduct ? canEdit : isAdmin;
  const newReleaseButton =
    canCreateRelease && !showShipped ? (
      <ReleaseCreate productId={activeProduct?.id ?? null} />
    ) : null;
  const newItemButton =
    canEdit && !activeLevel.isLeaf ? (
      <WorkItemCreate
        levelKey={activeLevel.key}
        levelLabel={activeLevel.label}
        parentLabel={parentLabel}
        parents={parents}
        productId={activeProduct?.id ?? null}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
        workflow={workflow}
        members={members}
        templateBody={templateBody}
      />
    ) : null;

  const board = (
    <RoadmapBoard
      // Remount when the data set changes (level or product scope) so the
      // board re-seeds its optimistic placement from the new features.
      key={`${
        scope.kind === "product"
          ? scope.product.id
          : scope.kind === "group"
            ? `group:${scope.group.id}`
            : ALL_PRODUCTS
      }:${activeLevel.key}:${showShipped ? "shipped" : "active"}`}
      columns={columns}
      features={features}
      workflow={workflow}
      productsById={productsById}
      customFieldLabels={customFieldLabels}
      memberNames={memberNames}
      releaseNames={releaseNames}
      allowDrag={canEdit && !showShipped}
      editableReleaseIds={editableReleaseIds}
      productNamesById={productNamesById}
    />
  );

  return (
    <BoardPrefsProvider
      board="roadmap"
      initialFields={cardFields}
      initialFeatured={featured}
      orderedKeys={catalog.map((f) => f.key)}
    >
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">
              {showShipped ? "Shipped releases" : "Roadmap"}
            </h1>
            <LevelSwitcher levels={levels} active={activeLevel.key} />
            {showShipped ? (
              <Link
                href={roadmapViewHref(org, productSlug, sp.level, false)}
                className="text-xs text-link hover:underline"
              >
                ← Active roadmap
              </Link>
            ) : shippedReleases.length > 0 ? (
              <Link
                href={roadmapViewHref(org, productSlug, sp.level, true)}
                className="text-xs text-link hover:underline"
              >
                Shipped releases ({shippedReleases.length}) →
              </Link>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {releaseCtaInEmptyState ? null : newReleaseButton}
            {itemCtaInEmptyState ? null : newItemButton}
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
        {features.length === 0 && scopedReleases.length === 0 ? (
          // Nothing at all yet: no items at this level and no releases.
          activeLevel.isLeaf ? (
            <NoSpecsEmptyState canConnect={canConnectRepos(access)} />
          ) : (
            <EmptyState
              className="mt-8"
              title="Nothing on the roadmap yet"
              description={`Releases are the ship vehicles on this roadmap, and ${activeLevel.label.toLowerCase()} items are the work you schedule into them. Create a release to plan against, add an item, then drag it into the release column.`}
              action={
                newReleaseButton || newItemButton ? (
                  <div className="flex items-center justify-center gap-2">
                    {newReleaseButton}
                    {newItemButton}
                  </div>
                ) : null
              }
            />
          )
        ) : features.length === 0 && !showShipped ? (
          // Releases exist but nothing at this level is scheduled: keep the
          // release columns visible and guide the next step above them.
          <>
            {activeLevel.isLeaf ? (
              <NoSpecsEmptyState
                variant="inline"
                className="py-4"
                canConnect={canConnectRepos(access)}
              />
            ) : (
              <EmptyState
                variant="inline"
                className="py-4"
                title={`No ${activeLevel.label.toLowerCase()} items to schedule yet`}
                description={
                  canEdit
                    ? "Create one, then drag it into a release column to plan it."
                    : "Once items exist at this level they can be scheduled into the releases below."
                }
                action={newItemButton}
              />
            )}
            {board}
          </>
        ) : (
          board
        )}
      </section>
    </BoardPrefsProvider>
  );
}

/** Build a roadmap link that toggles the shipped view while keeping the level. */
function roadmapViewHref(
  org: string,
  product: string,
  level: string | string[] | undefined,
  shipped: boolean,
): string {
  const params = new URLSearchParams();
  const levelKey = Array.isArray(level) ? level[0] : level;
  if (levelKey) params.set("level", levelKey);
  if (shipped) params.set("view", "shipped");
  const qs = params.toString();
  return orgProductPath(org, product, `/roadmap${qs ? `?${qs}` : ""}`);
}
