import Link from "next/link";

import { descendantGroupIds, resolveProductColor } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import {
  ReleaseProgress,
  StatusBar,
  StatusLegend,
  combineStatusCounts,
} from "@/components/status-rollup";
import { buttonVariants } from "@/components/ui/button";
import { GROUP_SLUG_PREFIX, ALL_PRODUCTS } from "@/lib/active-product";
import {
  LOCAL_ORG_SLUG,
  itemPath,
  orgPath,
  orgProductPath,
} from "@/lib/org-path";
import { productDotColor } from "@/lib/product-color";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { compareShippedReleases } from "@/lib/store/types";
import type {
  GroupProductSummary,
  ProductGroupRecord,
  ProductRecord,
  ReleaseRecord,
  SignalItem,
} from "@/lib/store/types";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Newest shipped releases worth showing; older history lives on the roadmap. */
const RECENT_SHIPPED = 5;

/** Today as YYYY-MM-DD in UTC. Resolved here so the signals are deterministic. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Leadership dashboard: one read-only portfolio snapshot across every product
 * the viewer can read, sitting above the product-scoped areas in the nav.
 *
 * Aggregates come from the store's workspace roll-up, which shares its
 * aggregation with the group roll-up, so this page and the group dashboard can
 * never disagree about what a status count means. Visibility is enforced at the
 * source: an unreadable product contributes nothing, so no total here betrays
 * that it exists.
 *
 * Read-only in v1: every number is either a link into the underlying view or
 * visibly plain text.
 */
export default async function LeadershipDashboardPage() {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const store = await getStore();
  const today = todayUtc();

  const workflow = await resolveWorkflowFor(access);
  const statusOrder = workflow.statuses.filter((s) => s !== "archived");
  // Work in flight: everything past the first stage and short of done. The
  // workflow is workspace-configurable, so the stage list decides this rather
  // than a hardcoded status key.
  const activeStatuses = statusOrder.slice(1).filter((s) => s !== "done");

  const [products, groups, releases, summary] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
    store.listReleases(access ?? undefined),
    store.getWorkspaceSummary({ today, activeStatuses }, access ?? undefined),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const releaseById = new Map(releases.map((r) => [r.id, r]));
  const totalItems = summary.products.reduce((a, s) => a + s.itemCount, 0);
  const totalCounts = combineStatusCounts(summary.products);

  // Release progress across the org: a portfolio release spans products, so the
  // per-product rows are summed by release rather than shown per product.
  const releaseTotals = new Map<string, { total: number; done: number }>();
  for (const p of summary.products) {
    for (const r of p.releases) {
      const entry = releaseTotals.get(r.releaseId) ?? { total: 0, done: 0 };
      entry.total += r.total;
      entry.done += r.done;
      releaseTotals.set(r.releaseId, entry);
    }
  }

  // Only releases whose product is readable (or portfolio-wide) reach here,
  // since listReleases is scoped the same way the summary is.
  const inFlight = releases
    .filter((r) => r.status === "in_progress")
    .sort(compareReleasesByTarget);
  const planned = releases
    .filter((r) => r.status === "planned")
    .sort(compareReleasesByTarget);
  const shipped = releases
    .filter((r) => r.status === "shipped")
    .sort(compareShippedReleases)
    .slice(0, RECENT_SHIPPED);

  // Top-level groups roll up their whole subtree; products in no group at all
  // are the gap a per-group roll-up cannot cover, so they get their own section.
  const topGroups = groups.filter((g) => g.parentId === null);
  const groupCards = topGroups.map((group) => {
    const subtree = descendantGroupIds(groups, group.id);
    const inSubtree = summary.products.filter((s) => {
      const groupId = productById.get(s.productId)?.groupId;
      return groupId != null && subtree.has(groupId);
    });
    return {
      group,
      productCount: inSubtree.length,
      itemCount: inSubtree.reduce((a, s) => a + s.itemCount, 0),
      counts: combineStatusCounts(inSubtree),
    };
  });
  const ungrouped = summary.products.filter(
    (s) => !productById.get(s.productId)?.groupId,
  );

  const signalSections: {
    key: string;
    title: string;
    hint: string;
    count: number;
    items: SignalItem[];
    all: { href: string; label: string };
  }[] = [
    {
      key: "blocked",
      title: "Blocked",
      hint: "Something has to finish before these can move.",
      count: summary.signals.counts.blocked,
      items: summary.signals.blocked,
      all: {
        href: orgProductPath(org, ALL_PRODUCTS, "/backlog"),
        label: "Backlog",
      },
    },
    {
      key: "overdue",
      title: "Past target date",
      hint: "Their release was due before today and they are not done.",
      count: summary.signals.counts.overdue,
      items: summary.signals.overdue,
      all: {
        href: orgProductPath(org, ALL_PRODUCTS, "/roadmap?view=timeline"),
        label: "Timeline",
      },
    },
    {
      key: "stale",
      title: "Stale in progress",
      hint: "In flight, but nothing has changed on them for two weeks.",
      count: summary.signals.counts.stale,
      items: summary.signals.stale,
      all: {
        href: orgProductPath(org, ALL_PRODUCTS, "/backlog"),
        label: "Backlog",
      },
    },
  ];

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">Portfolio</h1>
        <p className="text-sm text-muted-foreground">
          {summary.products.length}{" "}
          {summary.products.length === 1 ? "product" : "products"} ·{" "}
          {totalItems} {totalItems === 1 ? "item" : "items"} ·{" "}
          <Link
            href={orgProductPath(org, ALL_PRODUCTS, "/backlog")}
            className="hover:underline"
          >
            Backlog
          </Link>{" "}
          ·{" "}
          <Link
            href={orgProductPath(org, ALL_PRODUCTS, "/roadmap")}
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
          title="No products to report on yet"
          description="This dashboard rolls up the work across every product you can see. Create a product, then plan work into it."
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

      {groupCards.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">Groups</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {groupCards.map(({ group, productCount, itemCount, counts }) => (
              <GroupCard
                key={group.id}
                org={org}
                group={group}
                productCount={productCount}
                itemCount={itemCount}
                counts={counts}
                statusOrder={statusOrder}
              />
            ))}
          </div>
        </div>
      ) : null}

      {ungrouped.length > 0 ? (
        <div className="space-y-2">
          {/* Titled only when there are groups to distinguish these from. */}
          {groupCards.length > 0 ? (
            <h2 className="text-sm font-semibold tracking-tight">
              Ungrouped products
            </h2>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {ungrouped.map((s) => (
              <ProductRow
                key={s.productId}
                org={org}
                product={productById.get(s.productId)}
                summary={s}
                statusOrder={statusOrder}
                labels={workflow.labels}
              />
            ))}
          </div>
        </div>
      ) : null}

      {inFlight.length + planned.length + shipped.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight">Releases</h2>
          <div className="grid gap-3 lg:grid-cols-3">
            <ReleaseColumn
              title="In flight"
              org={org}
              releases={inFlight}
              totals={releaseTotals}
              productById={productById}
              empty="Nothing in flight."
            />
            <ReleaseColumn
              title="Planned"
              org={org}
              releases={planned}
              totals={releaseTotals}
              productById={productById}
              empty="Nothing planned."
            />
            <ReleaseColumn
              title="Recently shipped"
              org={org}
              releases={shipped}
              totals={releaseTotals}
              productById={productById}
              empty="Nothing shipped yet."
            />
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Worth escalating
        </h2>
        <div className="grid gap-3 lg:grid-cols-3">
          {signalSections.map((section) => (
            <SignalCard
              key={section.key}
              org={org}
              section={section}
              productById={productById}
              releaseById={releaseById}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Planned/in-flight order: soonest target first, undated last, then by name. */
function compareReleasesByTarget(a: ReleaseRecord, b: ReleaseRecord): number {
  if (a.targetDate !== b.targetDate) {
    if (a.targetDate === null) return 1;
    if (b.targetDate === null) return -1;
    return a.targetDate < b.targetDate ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function GroupCard({
  org,
  group,
  productCount,
  itemCount,
  counts,
  statusOrder,
}: {
  org: string;
  group: ProductGroupRecord;
  productCount: number;
  itemCount: number;
  counts: Record<string, number>;
  statusOrder: string[];
}) {
  return (
    <Link
      href={orgProductPath(org, `${GROUP_SLUG_PREFIX}${group.key}`, "/dashboard")}
      className="block space-y-2 rounded-md border p-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{group.name}</span>
        <span className="text-xs text-muted-foreground">
          {productCount} {productCount === 1 ? "product" : "products"} ·{" "}
          {itemCount} {itemCount === 1 ? "item" : "items"}
        </span>
      </div>
      <StatusBar counts={counts} statusOrder={statusOrder} />
    </Link>
  );
}

function ProductRow({
  org,
  product,
  summary,
  statusOrder,
  labels,
}: {
  org: string;
  product: ProductRecord | undefined;
  summary: GroupProductSummary;
  statusOrder: string[];
  labels: Record<string, string> | undefined;
}) {
  if (!product) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-baseline gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 self-center rounded-full"
          style={{
            backgroundColor: productDotColor(resolveProductColor(product)),
          }}
          aria-hidden
        />
        <Link
          href={orgProductPath(org, product.key, "/backlog")}
          className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    </div>
  );
}

function ReleaseColumn({
  title,
  org,
  releases,
  totals,
  productById,
  empty,
}: {
  title: string;
  org: string;
  releases: ReleaseRecord[];
  totals: Map<string, { total: number; done: number }>;
  productById: Map<string, ProductRecord>;
  empty: string;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {releases.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {releases.map((release) => {
            const product = release.productId
              ? productById.get(release.productId)
              : undefined;
            // A release's own view lives on the roadmap of the product that owns
            // it; a portfolio release belongs to the cross-product roadmap.
            const href = orgProductPath(
              org,
              product?.key ?? ALL_PRODUCTS,
              "/roadmap",
            );
            const progress = totals.get(release.id) ?? { total: 0, done: 0 };
            return (
              <li key={release.id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={href}
                    className="truncate text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {release.name}
                  </Link>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {product?.name ?? "Portfolio"}
                    {release.shippedDate
                      ? ` · ${release.shippedDate}`
                      : release.targetDate
                        ? ` · ${release.targetDate}`
                        : ""}
                  </span>
                </div>
                {progress.total > 0 ? (
                  <ReleaseProgress
                    name="Items"
                    done={progress.done}
                    total={progress.total}
                  />
                ) : (
                  <p className="text-2xs text-muted-foreground">
                    Nothing scheduled into it yet.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SignalCard({
  org,
  section,
  productById,
  releaseById,
}: {
  org: string;
  section: {
    title: string;
    hint: string;
    count: number;
    items: SignalItem[];
    all: { href: string; label: string };
  };
  productById: Map<string, ProductRecord>;
  releaseById: Map<string, ReleaseRecord>;
}) {
  const { title, hint, count, items, all } = section;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium">{title}</h3>
        <span className="text-sm font-semibold tabular-nums">{count}</span>
      </div>
      <p className="text-2xs text-muted-foreground">{hint}</p>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing to escalate.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {items.map((item) => {
              const product = item.productId
                ? productById.get(item.productId)
                : undefined;
              const release = item.releaseId
                ? releaseById.get(item.releaseId)
                : undefined;
              const context = [
                product?.name,
                release?.name,
                item.staleDays !== undefined
                  ? `${item.staleDays} days`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={item.specId} className="space-y-0.5">
                  {product ? (
                    <Link
                      href={itemPath(org, product.key, item)}
                      className="flex items-center gap-1.5 text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <StatusDot status={item.status} />
                      <span className="truncate">{item.title}</span>
                    </Link>
                  ) : (
                    // A legacy row with no product has no item route to link to.
                    <span className="flex items-center gap-1.5 text-xs">
                      <StatusDot status={item.status} />
                      <span className="truncate">{item.title}</span>
                    </span>
                  )}
                  {context ? (
                    <p className="pl-4 text-2xs text-muted-foreground">
                      {context}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {/*
            The list is a sample, so say how much of it is showing rather than
            letting the heading count imply the list is complete.
          */}
          <p className="text-2xs text-muted-foreground">
            {count > items.length
              ? `Showing ${items.length} of ${count}. `
              : null}
            <Link
              href={all.href}
              className="text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {all.label} →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
