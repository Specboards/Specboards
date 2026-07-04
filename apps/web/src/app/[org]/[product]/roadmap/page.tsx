import Link from "next/link";
import { notFound } from "next/navigation";

import { parentLevelKey, resolveWorkflow } from "@specboard/core";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import {
  ReleaseCreate,
  ReleaseDelete,
  ReleaseEdit,
  ReleaseReopen,
  ReleaseShip,
} from "@/components/release-controls";
import { StatusDot } from "@/components/status-dot";
import { WorkItemCreate } from "@/components/work-item-create";
import { resolveActiveLevel } from "@/lib/active-level";
import { ALL_PRODUCTS, resolveActiveProduct } from "@/lib/active-product";
import { itemPath, LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { sortFeatures, statusLabel } from "@/lib/feature-helpers";
import { productColorClasses } from "@/lib/product-color";
import { getDb } from "@/lib/db";
import { resolveRepoConfig } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  canWrite,
  listWorkspaceMembers,
  type WorkspaceMember,
} from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const RELEASE_STATUS_LABELS: Record<string, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/** Roadmap: items grouped by release (dated first), unscheduled work last. */
export default async function RoadmapPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);
  const isAdmin = !access || access.role === "admin";
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const sp = await searchParams;
  const store = await getStore();
  const allFeatures = sortFeatures(
    await store.listFeatures(access ?? undefined),
  ).filter((f) => f.status !== "archived");
  const releases = await store.listReleases(access ?? undefined);
  const detailTemplates = await store.listDetailTemplates(access ?? undefined);

  // Card creation needs the workspace status workflow (first status is the
  // default) and the assignable members.
  const repoConfig = await resolveRepoConfig(access);
  const workflow = resolveWorkflow(repoConfig);
  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];

  // Roadmap scopes to the product in the URL (`all` = every product) and shows
  // one hierarchy level at a time (default: the Feature altitude).
  const products = await store.listProducts(access ?? undefined);
  const activeProduct = resolveActiveProduct(products, productSlug);
  if (productSlug !== ALL_PRODUCTS && !activeProduct) notFound();
  const scoped = activeProduct
    ? allFeatures.filter((f) => f.productId === activeProduct.id)
    : allFeatures;

  // Cross-product view: tag each card with its owning product. Skipped when a
  // single product is in context or the workspace only has one product (the tag
  // carries no information then).
  const productsById =
    activeProduct || products.length <= 1
      ? undefined
      : Object.fromEntries(
          products.map((p) => [
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
  const parentLabel = levels.find((l) => l.key === parentKey)?.label ?? null;
  // Seed the new-item Details editor with the active level's assigned template.
  const templateBody =
    detailTemplates.find((t) => t.id === activeLevel.detailTemplateId)?.body ??
    "";

  // Shipped releases (and their items) leave the active roadmap and live under a
  // separate "Shipped releases" view (?view=shipped). Split the set so each view
  // only builds its own columns.
  const showShipped = sp.view === "shipped";
  const activeReleases = releases.filter((r) => r.status !== "shipped");
  const shippedReleases = releases.filter((r) => r.status === "shipped");
  const visibleReleases = showShipped ? shippedReleases : activeReleases;

  // One column per release (already ordered: dated first), unscheduled last.
  // `release` carries the full record so admins can edit it inline; it is null
  // for the trailing "Unscheduled" bucket. The Unscheduled column is only shown
  // (active view) when something is actually unscheduled, so a fully-planned
  // board stays tidy.
  const hasUnscheduled = !showShipped && features.some((f) => f.releaseId === null);
  const groups: Array<{
    releaseId: string | null;
    name: string;
    startDate: string | null;
    targetDate: string | null;
    status: string | null;
    release: (typeof releases)[number] | null;
  }> = [
    ...visibleReleases.map((r) => ({
      releaseId: r.id as string | null,
      name: r.name,
      startDate: r.startDate,
      targetDate: r.targetDate,
      status: r.status as string | null,
      release: r,
    })),
    ...(hasUnscheduled
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

  return (
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
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              ← Active roadmap
            </Link>
          ) : shippedReleases.length > 0 ? (
            <Link
              href={roadmapViewHref(org, productSlug, sp.level, true)}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Shipped releases ({shippedReleases.length}) →
            </Link>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && !showShipped ? <ReleaseCreate /> : null}
          {canEdit && !activeLevel.isLeaf ? (
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
          ) : null}
        </div>
      </div>
      {features.length === 0 && releases.length === 0 ? (
        activeLevel.isLeaf ? (
          <EmptyState canConnect={canConnectRepos(access)} />
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No {activeLevel.label.toLowerCase()} items yet.
            {canEdit ? ` Use “New ${activeLevel.label.toLowerCase()}” to add one.` : ""}
            {isAdmin ? " Create a release to start planning." : ""}
          </p>
        )
      ) : (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groups.map((group) => {
          const items = features.filter((f) => f.releaseId === group.releaseId);
          return (
            <div key={group.releaseId ?? "unscheduled"} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {group.name}
                  {formatReleaseDates(group.startDate, group.targetDate) ? (
                    <span className="ml-2 font-normal">
                      {formatReleaseDates(group.startDate, group.targetDate)}
                    </span>
                  ) : null}
                  {group.status && group.status !== "planned" ? (
                    <span className="ml-2 font-normal">
                      · {RELEASE_STATUS_LABELS[group.status] ?? group.status}
                    </span>
                  ) : null}
                </h2>
                {isAdmin && group.release ? (
                  <span className="flex shrink-0 items-center gap-2">
                    {showShipped ? (
                      <ReleaseReopen
                        id={group.release.id}
                        name={group.release.name}
                      />
                    ) : (
                      <ReleaseShip
                        id={group.release.id}
                        name={group.release.name}
                      />
                    )}
                    <ReleaseEdit
                      id={group.release.id}
                      name={group.release.name}
                      status={group.release.status}
                      startDate={group.release.startDate}
                      targetDate={group.release.targetDate}
                    />
                    <ReleaseDelete
                      id={group.release.id}
                      name={group.release.name}
                    />
                  </span>
                ) : null}
              </div>
              {items.map((f) => {
                const product =
                  productsById && f.productId ? productsById[f.productId] : undefined;
                return (
                <Card key={f.specId} className="rounded-lg shadow-none">
                  <CardHeader className="space-y-1 p-3">
                    {product ? (
                      <Badge
                        variant="secondary"
                        className={cn("w-fit border-transparent text-[10px]", productColorClasses(product).badge)}
                      >
                        {product.name}
                      </Badge>
                    ) : null}
                    <CardTitle className="text-sm">
                      <Link
                        href={itemPath(org, productSlug, f)}
                        className="hover:underline"
                      >
                        {f.title}
                      </Link>
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <StatusDot status={f.status} />
                      {statusLabel(f.status)}
                    </CardDescription>
                  </CardHeader>
                </Card>
                );
              })}
              {items.length === 0 && (
                <p className="text-xs text-muted-foreground">Empty</p>
              )}
            </div>
          );
        })}
      </div>
      )}
    </section>
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

/** Render a release's date range as "start → ship", omitting missing ends. */
function formatReleaseDates(
  startDate: string | null,
  targetDate: string | null,
): string | null {
  if (startDate && targetDate) return `${startDate} → ${targetDate}`;
  if (targetDate) return `→ ${targetDate}`;
  if (startDate) return `${startDate} →`;
  return null;
}
