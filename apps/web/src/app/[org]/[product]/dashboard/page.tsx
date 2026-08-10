import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { descendantGroupIds, resolveProductColor } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import {
  ReleaseProgress,
  StatusBar,
  StatusLegend,
  combineStatusCounts,
} from "@/components/status-rollup";
import { buttonVariants } from "@/components/ui/button";
import { GROUP_SLUG_PREFIX, resolveActiveScope } from "@/lib/active-product";
import { LOCAL_ORG_SLUG, orgPath, orgProductPath } from "@/lib/org-path";
import { productDotColor } from "@/lib/product-color";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type {
  GroupProductSummary,
  ProductRecord,
  ReleaseRecord,
} from "@/lib/store/types";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Group dashboard: a management roll-up of a product group's subtree. Per
 * product: item count, status breakdown, release progress. Direct subgroups
 * get their own aggregate cards linking to their dashboards. Only renders for
 * a `~{key}` group scope; a plain product (or "all") redirects to the backlog,
 * which is that scope's home view.
 */
export default async function GroupDashboardPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const store = await getStore();

  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);
  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();
  if (scope.kind !== "group") {
    redirect(orgProductPath(org, productSlug, "/backlog"));
  }

  const [summary, releases, workflow] = await Promise.all([
    store.getGroupSummary(scope.group.id, access ?? undefined),
    store.listReleases(access ?? undefined),
    // Group scope only (the guard above redirects anything narrower), so there
    // is no single product to resolve transitions for: the workspace default is
    // the right common denominator for ordering a group's stage columns.
    resolveWorkflowFor(access),
  ]);
  const statusOrder = workflow.statuses.filter((s) => s !== "archived");
  const releaseName = new Map(
    releases.map((r: ReleaseRecord) => [r.id, r.name]),
  );
  const productById = new Map(products.map((p) => [p.id, p]));
  const summariesById = new Map(summary.products.map((s) => [s.productId, s]));

  const totalItems = summary.products.reduce((a, s) => a + s.itemCount, 0);
  const totalCounts = combineStatusCounts(summary.products);

  // Each direct subgroup's aggregate covers its whole subtree.
  const subgroupCards = summary.subgroups.map((sub) => {
    const subtree = descendantGroupIds(groups, sub.id);
    const subSummaries = summary.products.filter((s) => {
      const groupId = productById.get(s.productId)?.groupId;
      return groupId != null && subtree.has(groupId);
    });
    return {
      group: sub,
      itemCount: subSummaries.reduce((a, s) => a + s.itemCount, 0),
      productCount: subSummaries.length,
      counts: combineStatusCounts(subSummaries),
    };
  });

  // Products directly in this group (subtree products of subgroups are
  // represented by the subgroup cards; listing both would double-show them).
  const directProducts = summary.products.filter(
    (s) => productById.get(s.productId)?.groupId === scope.group.id,
  );

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">
          {summary.group.name}
        </h1>
        {summary.group.description ? (
          <p className="text-sm text-muted-foreground">
            {summary.group.description}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {summary.products.length}{" "}
          {summary.products.length === 1 ? "product" : "products"} ·{" "}
          {totalItems} {totalItems === 1 ? "item" : "items"} ·{" "}
          <Link
            href={orgProductPath(org, productSlug, "/backlog")}
            className="hover:underline"
          >
            Backlog
          </Link>{" "}
          ·{" "}
          <Link
            href={orgProductPath(org, productSlug, "/roadmap")}
            className="hover:underline"
          >
            Roadmap
          </Link>
        </p>
        <StatusBar counts={totalCounts} statusOrder={statusOrder} />
        <StatusLegend
          counts={totalCounts}
          statusOrder={statusOrder}
          labels={workflow.labels}
        />
      </div>

      {summary.products.length === 0 ? (
        <EmptyState
          title="No products in this group yet"
          description="A group dashboard rolls up the work across its products. Assign products to this group to see their combined status here."
          action={
            <Link
              href={orgPath(org, "/settings/products")}
              className={buttonVariants({ size: "sm" })}
            >
              Manage products
            </Link>
          }
        />
      ) : null}

      {subgroupCards.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">Subgroups</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {subgroupCards.map(
              ({ group: sub, itemCount, productCount, counts }) => (
                <Link
                  key={sub.id}
                  href={orgProductPath(
                    org,
                    `${GROUP_SLUG_PREFIX}${sub.key}`,
                    "/dashboard",
                  )}
                  className="block space-y-2 rounded-md border p-3 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{sub.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {productCount}{" "}
                      {productCount === 1 ? "product" : "products"} ·{" "}
                      {itemCount} {itemCount === 1 ? "item" : "items"}
                    </span>
                  </div>
                  <StatusBar counts={counts} statusOrder={statusOrder} />
                </Link>
              ),
            )}
          </div>
        </div>
      ) : null}

      {directProducts.length > 0 ? (
        <div className="space-y-2">
          {subgroupCards.length > 0 ? (
            <h2 className="text-sm font-semibold tracking-tight">Products</h2>
          ) : null}
          <div className="space-y-3">
            {directProducts.map((s) => (
              <ProductSummaryCard
                key={s.productId}
                summary={s}
                product={productById.get(s.productId)}
                org={org}
                statusOrder={statusOrder}
                labels={workflow.labels}
                releaseName={releaseName}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProductSummaryCard({
  summary,
  product,
  org,
  statusOrder,
  labels,
  releaseName,
}: {
  summary: GroupProductSummary;
  product: ProductRecord | undefined;
  org: string;
  statusOrder: string[];
  labels: Record<string, string> | undefined;
  releaseName: Map<string, string>;
}) {
  if (!product) return null;
  // Show dated/active releases the product participates in, most complete last.
  const releaseRows = summary.releases
    .map((r) => ({ ...r, name: releaseName.get(r.releaseId) }))
    .filter((r): r is typeof r & { name: string } => Boolean(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-baseline gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 self-center rounded-full"
          style={{ backgroundColor: productDotColor(resolveProductColor(product)) }}
          aria-hidden
        />
        <Link
          href={orgProductPath(org, product.key, "/backlog")}
          className="font-medium hover:underline"
        >
          {product.name}
        </Link>
        <span className="text-xs text-muted-foreground">
          {summary.itemCount} {summary.itemCount === 1 ? "item" : "items"}
        </span>
      </div>
      <StatusBar counts={summary.statusCounts} statusOrder={statusOrder} />
      <StatusLegend
        counts={summary.statusCounts}
        statusOrder={statusOrder}
        labels={labels}
      />
      {releaseRows.length > 0 ? (
        <div className="space-y-1 border-t pt-2">
          {releaseRows.map((r) => (
            <ReleaseProgress
              key={r.releaseId}
              name={r.name}
              done={r.done}
              total={r.total}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
