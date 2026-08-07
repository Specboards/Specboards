import Link from "next/link";
import { notFound } from "next/navigation";

import { parentLevelKey, propertyAppliesToLevel } from "@specboards/core";

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
import { compareShippedReleases, goalsForProduct } from "@/lib/store/types";
import { listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import {
  canConnectRepos,
  canEditProducts,
  requireWorkspaceAccess,
} from "@/lib/workspace-access";
import {
  AXIS_SCALES,
  DEFAULT_AXIS_SCALE,
  buildTimeline,
  parseAxisScale,
  parseDateSource,
  type AxisScale,
} from "@/lib/roadmap-timeline";
import { buildLadder } from "@/lib/roadmap-ladder";
import { buildGoalTimeline } from "@/lib/roadmap-goals";
import { DateSourcePicker } from "./date-source-picker";
import { GoalTimelineEmptyState, RoadmapGoalLanes } from "./roadmap-goal-lanes";
import { RoadmapLadder } from "./roadmap-ladder";
import { RoadmapBoard, type RoadmapColumn } from "./roadmap-board";
import {
  RoadmapTimeline,
  TimelineEmptyState,
  TimelineRowsToggle,
  TimelineShippedToggle,
  TimelineZoom,
  type TimelineRows,
} from "./roadmap-timeline";

export const dynamic = "force-dynamic";

/** Today as YYYY-MM-DD in UTC, for the timeline's today marker. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First value of a possibly-repeated query param. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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
  const properties = await store.listProperties(access ?? undefined, "item");
  // Release-scoped custom properties power the editor in the release detail sheet.
  const releaseProperties = await store.listProperties(
    access ?? undefined,
    "release",
  );

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
  const customFieldTypes = Object.fromEntries(
    properties.map((p) => [p.key, p.type]),
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
  const view = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const showShipped = view === "shipped";
  // The timeline is a peer view, not a sub-mode of the board: on a time axis
  // shipped history and upcoming work belong side by side, so it draws from
  // every dated release in scope rather than honouring the shipped/active split
  // the column layout needs.
  const showTimeline = view === "timeline";
  const activeReleases = scopedReleases.filter((r) => r.status !== "shipped");
  // Shipped releases read newest-first (most recent on the left) so the latest
  // ship isn't buried at the end of a long history; active releases keep the
  // planned ascending order they arrive in.
  const shippedReleases = scopedReleases
    .filter((r) => r.status === "shipped")
    .sort(compareShippedReleases);
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
      shippedDate: r.shippedDate,
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
            shippedDate: null,
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
    features.length === 0 && !showShipped && !showTimeline;
  const releaseCtaInEmptyState =
    itemCtaInEmptyState && scopedReleases.length === 0;
  // A product roadmap creates a release for that product (admins/contributors);
  // the aggregate roadmap creates a portfolio release (owner only).
  const canCreateRelease = activeProduct ? canEdit : isAdmin;
  const newReleaseButton =
    canCreateRelease && !showShipped ? (
      <ReleaseCreate productId={activeProduct?.id ?? null} />
    ) : null;
  // Every level is creatable, leaf included (ADR 0003).
  const newItemButton =
    canEdit ? (
      <WorkItemCreate
        levelKey={activeLevel.key}
        levelLabel={activeLevel.label}
        parentLabel={parentLabel}
        parents={parents}
        productId={activeProduct?.id ?? null}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
        releases={activeReleases.map((r) => ({
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

  // Per-column quick add: same single-product gate as the backlog board (a
  // release column can only create into an unambiguous product). Off in the
  // shipped view. The new item inherits the column's release; status defaults
  // to the workflow's first stage.
  const quickAddProductId =
    activeProduct?.id ??
    (scopedProducts.length === 1 ? scopedProducts[0]?.id ?? null : null);
  const quickAdd =
    canEdit && !showShipped && quickAddProductId
      ? {
          levelKey: activeLevel.key,
          levelLabel: activeLevel.label,
          productId: quickAddProductId,
          status: workflow.statuses[0] ?? "backlog",
        }
      : undefined;

  // Bulk multi-select reuses the backlog board's action bar. Offered to editors
  // on the active view only (the shipped view is read-only, like drag); the
  // client also hides it on the mobile swipe layout. Releases to schedule into
  // are the active (non-shipped) columns; the bar adds its own "No release".
  const bulkOptions =
    canEdit && !showShipped
      ? {
          statuses: workflow.statuses.filter((s) => s !== "archived"),
          assignees: members.map((m) => ({ userId: m.userId, name: m.name })),
          releases: activeReleases.map((r) => ({ id: r.id, name: r.name })),
        }
      : undefined;

  // Timeline model. Built from every dated release in scope (see showTimeline
  // above) and the items at the active level; anything that cannot be placed
  // lands in the model's `undated` tray rather than being dropped.
  const today = todayUtc();
  // Date-typed custom properties are what the timeline can plot by besides the
  // release span. Only properties that apply at the active level are offered,
  // so the picker never lists a field the visible items cannot carry.
  const dateFields = properties
    .filter(
      (p) => p.type === "date" && propertyAppliesToLevel(p, activeLevel.key),
    )
    .map((p) => ({ key: p.key, label: p.label }));
  const dateFieldKeys = dateFields.map((f) => f.key);
  const dateSources = {
    start: parseDateSource(sp.start, dateFieldKeys),
    end: parseDateSource(sp.end, dateFieldKeys),
  };
  const plottedByField =
    dateSources.start.kind === "property" || dateSources.end.kind === "property";
  const axisScale = parseAxisScale(sp.zoom);
  // How the rows are grouped. Three readings of the same bars on the same axis:
  // release bands (what ships when), the hierarchy ladder (what sits under
  // what, lib/roadmap-ladder.ts), and goal swimlanes (what the work is for,
  // lib/roadmap-goals.ts).
  //
  // `?ladder=1` was the spelling before this became a three-way choice; it is
  // still read so links shared back then keep landing on the ladder.
  const rowsParam = first(sp.rows);
  const rows: TimelineRows =
    rowsParam === "goals"
      ? "goals"
      : rowsParam === "ladder" || first(sp.ladder) === "1"
        ? "ladder"
        : "releases";
  const showLadder = showTimeline && rows === "ladder";
  const showGoals = showTimeline && rows === "goals";
  // Shipped history is on by default (the timeline is the one view where past
  // and future belong side by side) and hidden with `?shipped=0`.
  const hideShipped = first(sp.shipped) === "0";
  const timelineReleases = scopedReleases.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    startDate: r.startDate,
    targetDate: r.targetDate,
    shippedDate: r.shippedDate,
  }));
  // Bar fill is read from how far a status has moved through the workflow, so
  // the order is the workflow's, minus the archived terminal (nothing archived
  // is on the board).
  const statusOrder = workflow.statuses.filter((s) => s !== "archived");
  const timeline =
    showTimeline && !showLadder && !showGoals
      ? buildTimeline(
          features.map((f) => ({
            specId: f.specId,
            title: f.title,
            status: f.status,
            level: f.level,
            releaseId: f.releaseId,
            productId: f.productId,
            customFields: f.customFields,
            childCount: f.childCount,
            childDoneCount: f.childDoneCount,
          })),
          timelineReleases,
          today,
          dateSources,
          axisScale,
          { statusOrder, hideShipped },
        )
      : null;

  // The ladder needs every item in scope, not just the active level: rows below
  // the active level are its children, and items deeper still feed rolled-up
  // parent spans even when they are not drawn.
  // The shipped filter expressed in the ladder's own terms: its rows are items,
  // not releases, so hiding shipped history means dropping the releases and the
  // work scheduled into them before the model is built. (The release timeline
  // does the same inside buildTimeline, where releases are the rows.)
  const shippedReleaseIds = new Set(
    timelineReleases.filter((r) => r.status === "shipped").map((r) => r.id),
  );
  const ladderReleases = hideShipped
    ? timelineReleases.filter((r) => !shippedReleaseIds.has(r.id))
    : timelineReleases;
  const ladderItems = hideShipped
    ? scoped.filter((f) => !f.releaseId || !shippedReleaseIds.has(f.releaseId))
    : scoped;

  const ladder = showLadder
    ? buildLadder({
        items: ladderItems.map((f) => ({
          specId: f.specId,
          title: f.title,
          status: f.status,
          level: f.level,
          releaseId: f.releaseId,
          productId: f.productId,
          customFields: f.customFields,
          parentSpecId: f.parentSpecId,
          childCount: f.childCount,
          childDoneCount: f.childDoneCount,
        })),
        releases: ladderReleases,
        activeLevel: activeLevel.key,
        levelOrder: levels.map((l) => l.key),
        statusOrder,
        blockingEdges: await store.listBlockingEdges(access ?? undefined),
        today,
        sources: dateSources,
        scale: axisScale,
      })
    : null;

  // Goal swimlanes. Scoped the same way the Goals page scopes them: a product
  // sees its own goals plus org-wide ones, a broader scope sees every goal
  // whose product it covers. Fetched only for this view, since neither the
  // board nor the other two timelines need the link graph.
  const [scopedGoals, goalLinks] = showGoals
    ? await Promise.all([
        store.listGoals(access ?? undefined).then((all) =>
          activeProduct
            ? goalsForProduct(all, activeProduct.id)
            : all.filter((g) => g.productId === null || inScope(g.productId)),
        ),
        store.listGoalLinks(access ?? undefined),
      ])
    : [[], []];

  // A lane draws work at every level, not just the active one: a goal is served
  // by an initiative and by a single work item alike, and filtering to the
  // level switcher's choice would silently empty the lanes that matter most.
  const goalTimeline = showGoals
    ? buildGoalTimeline({
        goals: scopedGoals.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          productId: g.productId,
          periodStart: g.periodStart,
          periodEnd: g.periodEnd,
          progress: g.progress,
          deliveryProgress: g.deliveryProgress,
          linkedItemCount: g.linkedItemCount,
        })),
        items: ladderItems.map((f) => ({
          specId: f.specId,
          title: f.title,
          status: f.status,
          level: f.level,
          releaseId: f.releaseId,
          productId: f.productId,
          customFields: f.customFields,
        })),
        releases: ladderReleases,
        links: goalLinks,
        today,
        sources: dateSources,
        scale: axisScale,
      })
    : null;

  // One href per zoom, each keeping every other param (level, filters, plotted
  // fields) so changing granularity never resets the view around it.
  const zoomHrefs = Object.fromEntries(
    AXIS_SCALES.map((scale) => [
      scale,
      roadmapZoomHref(org, productSlug, sp, scale),
    ]),
  ) as Record<AxisScale, string>;

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
      customFieldTypes={customFieldTypes}
      memberNames={memberNames}
      releaseNames={releaseNames}
      allowDrag={canEdit && !showShipped}
      editableReleaseIds={editableReleaseIds}
      productNamesById={productNamesById}
      releaseProperties={releaseProperties}
      members={members}
      quickAdd={quickAdd}
      bulkOptions={bulkOptions}
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
              {showShipped
                ? "Shipped releases"
                : showTimeline
                  ? "Timeline"
                  : "Roadmap"}
            </h1>
            <LevelSwitcher levels={levels} active={activeLevel.key} />
            {showShipped || showTimeline ? (
              <Link
                href={roadmapViewHref(org, productSlug, sp.level, "board")}
                className="text-xs text-link hover:underline"
              >
                ← Roadmap board
              </Link>
            ) : (
              <>
                <Link
                  href={roadmapViewHref(org, productSlug, sp.level, "timeline")}
                  className="text-xs text-link hover:underline"
                >
                  Timeline →
                </Link>
                {shippedReleases.length > 0 ? (
                  <Link
                    href={roadmapViewHref(org, productSlug, sp.level, "shipped")}
                    className="text-xs text-link hover:underline"
                  >
                    Shipped releases ({shippedReleases.length}) →
                  </Link>
                ) : null}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {releaseCtaInEmptyState ? null : newReleaseButton}
            {itemCtaInEmptyState ? null : newItemButton}
            {features.length > 0 && canEdit && !showTimeline ? (
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
        {showTimeline ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <DateSourcePicker
                  fields={dateFields}
                  start={dateSources.start}
                  end={dateSources.end}
                />
                <TimelineRowsToggle
                  active={rows}
                  // Every href clears the legacy `ladder` param, so switching
                  // rows from an old link cannot leave the two disagreeing.
                  hrefs={{
                    releases: roadmapParamHref(org, productSlug, sp, {
                      rows: null,
                      ladder: null,
                    }),
                    ladder: roadmapParamHref(org, productSlug, sp, {
                      rows: "ladder",
                      ladder: null,
                    }),
                    goals: roadmapParamHref(org, productSlug, sp, {
                      rows: "goals",
                      ladder: null,
                    }),
                  }}
                />
                {/* Only offered when there is shipped history in scope to hide. */}
                {shippedReleases.length > 0 ? (
                  <TimelineShippedToggle
                    hidden={hideShipped}
                    count={shippedReleases.length}
                    href={roadmapParamHref(org, productSlug, sp, {
                      shipped: hideShipped ? null : "0",
                    })}
                  />
                ) : null}
              </div>
              {/* Zoom is offered whenever there is an axis to zoom. */}
              {timeline || ladder || goalTimeline ? (
                <TimelineZoom active={axisScale} hrefs={zoomHrefs} />
              ) : null}
            </div>
            {showGoals ? (
              goalTimeline ? (
                <RoadmapGoalLanes
                  model={goalTimeline}
                  org={org}
                  productSlug={productSlug}
                  productNamesById={productsById ? productNamesById : undefined}
                  productKeysById={Object.fromEntries(
                    products.map((p) => [p.id, p.key]),
                  )}
                  today={today}
                  levelLabels={Object.fromEntries(
                    levels.map((l) => [l.key, l.label]),
                  )}
                  // Lanes are goals, not levels, so the collapse state is per
                  // scope only: the level switcher does not reshape this view.
                  stateKey={productSlug}
                />
              ) : (
                <GoalTimelineEmptyState hasGoals={scopedGoals.length > 0} />
              )
            ) : ladder ? (
              <RoadmapLadder
                model={ladder}
                org={org}
                productSlug={productSlug}
                productNamesById={productsById ? productNamesById : undefined}
                today={today}
                // Collapse state is per scope and level, so expanding the
                // initiative ladder does not reshape the epic one.
                stateKey={`${productSlug}:${activeLevel.key}`}
              />
            ) : timeline ? (
              <RoadmapTimeline
                model={timeline}
                org={org}
                productSlug={productSlug}
                // Product attribution only where it carries information: the
                // same multi-product test the board's card tags use.
                productNamesById={productsById ? productNamesById : undefined}
                today={today}
                sources={dateSources}
                dateFieldLabels={Object.fromEntries(
                  dateFields.map((f) => [f.key, f.label]),
                )}
                requestedScale={axisScale}
                // Collapse state is per scope and level, so folding up the
                // feature timeline does not reshape the epic one.
                stateKey={`${productSlug}:${activeLevel.key}`}
              />
            ) : (
              <TimelineEmptyState
                action={plottedByField ? null : newReleaseButton}
                plottedByField={plottedByField}
                shippedHidden={hideShipped && shippedReleases.length > 0}
              />
            )}
          </>
        ) : features.length === 0 && scopedReleases.length === 0 ? (
          // Nothing at all yet: no items at this level and no releases.
          activeLevel.isLeaf ? (
            <NoSpecsEmptyState
              canConnect={canConnectRepos(access)}
              createAction={newItemButton}
            />
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
                createAction={newItemButton}
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

/**
 * Build a roadmap link that switches the view while keeping the level, so
 * moving between the board, the timeline, and shipped releases never silently
 * resets the altitude the user was working at.
 */
function roadmapViewHref(
  org: string,
  product: string,
  level: string | string[] | undefined,
  view: "board" | "timeline" | "shipped",
): string {
  const params = new URLSearchParams();
  const levelKey = Array.isArray(level) ? level[0] : level;
  if (levelKey) params.set("level", levelKey);
  if (view !== "board") params.set("view", view);
  const qs = params.toString();
  return orgProductPath(org, product, `/roadmap${qs ? `?${qs}` : ""}`);
}

/**
 * Build a roadmap link that changes only the named params, preserving every
 * other one the current URL carries (level, view, plotted fields, filters,
 * zoom). A null value drops the param, so a toggle's "off" state is the clean
 * URL rather than an explicit `=0`.
 */
function roadmapParamHref(
  org: string,
  product: string,
  sp: Record<string, string | string[] | undefined>,
  patch: Record<string, string | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key in patch || value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      params.append(key, one);
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null) params.set(key, value);
  }
  const qs = params.toString();
  return orgProductPath(org, product, `/roadmap${qs ? `?${qs}` : ""}`);
}

/** The zoom link for one scale; the default scale is left out of the URL. */
function roadmapZoomHref(
  org: string,
  product: string,
  sp: Record<string, string | string[] | undefined>,
  scale: AxisScale,
): string {
  return roadmapParamHref(org, product, sp, {
    zoom: scale === DEFAULT_AXIS_SCALE ? null : scale,
  });
}
