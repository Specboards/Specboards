import { notFound } from "next/navigation";

import { resolveIdeaStages } from "@specboard/core";

import { IdeasBoard } from "@/components/ideas-board";
import { ALL_PRODUCTS, resolveActiveProduct } from "@/lib/active-product";
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

  const [allIdeas, stageRows, products] = await Promise.all([
    store.listIdeas(access ?? undefined),
    store.listIdeaStatuses(access ?? undefined),
    store.listProducts(access ?? undefined),
  ]);

  const activeProduct = resolveActiveProduct(products, productSlug);
  if (productSlug !== ALL_PRODUCTS && !activeProduct) notFound();
  const canEdit = canEditProducts(access, products, activeProduct?.id ?? null);
  const ideas = activeProduct
    ? allIdeas.filter((i) => i.productId === activeProduct.id)
    : allIdeas;

  const stages = resolveIdeaStages(stageRows);

  // Cross-product view tags each idea with its owning product (skipped when a
  // single product is in context or the org has just one product).
  const productsById =
    activeProduct || products.length <= 1
      ? undefined
      : Object.fromEntries(products.map((p) => [p.id, p.name]));

  return (
    <IdeasBoard
      ideas={ideas}
      stages={stages}
      canEdit={canEdit}
      org={org}
      productSlug={productSlug}
      defaultProductId={activeProduct?.id ?? null}
      products={products.map((p) => ({ id: p.id, name: p.name }))}
      productsById={productsById}
    />
  );
}
