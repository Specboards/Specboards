import { notFound } from "next/navigation";

import { ActivityView } from "@/components/activity-view";
import { activityWindow, resolveRange } from "@/lib/activity-report";
import { resolveActiveScope } from "@/lib/active-product";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Activity: reporting over the change ledger for the product in the URL.
 *
 * Scoped like every other product view. A group scope reports its subtree's
 * products rather than the workspace, because a group's page carrying the
 * workspace's numbers would overstate that group's output to the person least
 * placed to notice.
 */
export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; product: string }>;
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const { range: rawRange } = await searchParams;
  const store = await getStore();

  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);
  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();

  const range = resolveRange(rawRange);
  const window = activityWindow(range.days, new Date());
  const productIds =
    scope.kind === "product"
      ? [scope.product.id]
      : scope.kind === "group"
        ? [...scope.productIds]
        : null;

  const [summary, workflow] = await Promise.all([
    store.itemActivitySummary({ ...window, productIds }, access ?? undefined),
    resolveWorkflowFor(access),
  ]);

  const scopeLabel =
    scope.kind === "product"
      ? scope.product.name
      : scope.kind === "group"
        ? scope.group.name
        : "All products";

  return (
    <ActivityView
      summary={summary}
      window={window}
      rangeKey={range.key}
      scopeLabel={scopeLabel}
      basePath={orgProductPath(org, productSlug, "/activity")}
      workflow={workflow}
    />
  );
}
