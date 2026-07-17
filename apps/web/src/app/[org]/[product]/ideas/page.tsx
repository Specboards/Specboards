import { notFound } from "next/navigation";

import { resolveIdeaStages } from "@specboard/core";

import { IdeasBoard } from "@/components/ideas-board";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
import { LOCAL_ORG_SLUG } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import { canEditProducts, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Ideas: the internal view where the team captures feature requests / feedback,
 * votes on them, and promotes the worthwhile ones into feature work. Scoped to
 * the product in the URL (`all` = every product). A public voting portal built
 * on the same data is a later phase (see Settings -> Ideas).
 */
export default async function IdeasPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const store = await getStore();

  const [allIdeas, stageRows, products, groups] = await Promise.all([
    store.listIdeas(access ?? undefined),
    store.listIdeaStatuses(access ?? undefined),
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
  const ideas = allIdeas.filter((i) => inScope(i.productId));

  const stages = resolveIdeaStages(stageRows);

  // Multi-product scope ("all" or a group) tags each idea with its owning
  // product (skipped when a single product is in context or the scope only
  // covers one product).
  const scopedProducts =
    scope.kind === "group"
      ? products.filter((p) => scope.productIds.has(p.id))
      : products;
  const productsById =
    activeProduct || scopedProducts.length <= 1
      ? undefined
      : Object.fromEntries(scopedProducts.map((p) => [p.id, p.name]));

  return (
    <IdeasBoard
      ideas={ideas}
      stages={stages}
      canEdit={canEdit}
      org={org}
      productSlug={productSlug}
      defaultProductId={activeProduct?.id ?? null}
      products={scopedProducts.map((p) => ({ id: p.id, name: p.name }))}
      productsById={productsById}
    />
  );
}
