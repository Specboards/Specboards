import { notFound } from "next/navigation";

import { CyclesView } from "@/components/cycles-view";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
import { LOCAL_ORG_SLUG } from "@/lib/org-path";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { cyclesForProduct } from "@/lib/store/types";
import { canEditProducts, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Cycles: the team-facing time boxes work is planned into, a second axis
 * alongside releases rather than a replacement for them. A release answers
 * "what ships together"; a cycle answers "what is the team working on for the
 * next two weeks", and an item can sit in both.
 *
 * Scoped to the product in the URL (`all` = every product), which also decides
 * which cycles are in view: a product's own, plus the workspace-wide ones that
 * apply everywhere.
 */
export default async function CyclesPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const store = await getStore();

  const [allCycles, allFeatures, products, groups, levels] = await Promise.all([
    store.listCycles(access ?? undefined),
    store.listFeatures(access ?? undefined),
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
    store.listLevels(access ?? undefined),
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
  const workflow = await resolveWorkflowFor(access);

  const inScope = scopeProductFilter(scope);
  // A single product sees its own cycles plus workspace-wide ones; a broader
  // scope sees every cycle whose product it covers, workspace-wide included.
  const cycles = activeProduct
    ? cyclesForProduct(allCycles, activeProduct.id)
    : allCycles.filter((c) => c.productId === null || inScope(c.productId));

  const cycleIds = new Set(cycles.map((c) => c.id));
  const items = allFeatures
    .filter((f) => f.cycleId && cycleIds.has(f.cycleId) && inScope(f.productId))
    .map((f) => ({
      specId: f.specId,
      title: f.title,
      status: f.status,
      level: f.level,
      cycleId: f.cycleId!,
      productId: f.productId,
    }));

  const scopedProducts =
    scope.kind === "group"
      ? products.filter((p) => scope.productIds.has(p.id))
      : products;

  return (
    <CyclesView
      cycles={cycles}
      items={items}
      workflow={workflow}
      canEdit={canEdit}
      org={org}
      productSlug={productSlug}
      levels={levels.map((l) => ({ key: l.key, label: l.label }))}
      defaultProductId={activeProduct?.id ?? null}
      products={scopedProducts.map((p) => ({ id: p.id, name: p.name }))}
    />
  );
}
