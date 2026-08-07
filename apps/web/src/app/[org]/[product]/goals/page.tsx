import { notFound } from "next/navigation";

import { GoalsView } from "@/components/goals-view";
import { resolveActiveScope, scopeProductFilter } from "@/lib/active-product";
import { LOCAL_ORG_SLUG } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import { goalsForProduct } from "@/lib/store/types";
import { canEditProducts, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Goals: what the team is trying to achieve, and the work laddering up to it.
 *
 * A goal is deliberately not a hierarchy level. It is measured (a level is
 * not), and the work serving it is many-to-many and crosses products, which
 * the single-parent item hierarchy cannot express. So goals live here, beside
 * the prose Strategy area rather than replacing it: strategy stays prose,
 * goals are the part with a number on it.
 */
export default async function GoalsPage({
  params,
}: {
  params: Promise<{ org: string; product: string }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product: productSlug } = await params;
  const store = await getStore();

  const [allGoals, allFeatures, products, groups, levels] = await Promise.all([
    store.listGoals(access ?? undefined),
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

  const inScope = scopeProductFilter(scope);
  // A single product sees its own goals plus org-wide ones; a broader scope
  // sees every goal whose product it covers, org-wide included.
  const goals = activeProduct
    ? goalsForProduct(allGoals, activeProduct.id)
    : allGoals.filter((g) => g.productId === null || inScope(g.productId));

  // Contributions for every goal in one pass, rather than a query per goal.
  const contributions = await Promise.all(
    goals.map((g) => store.listGoalContributions(g.id, access ?? undefined)),
  );
  const contributionsByGoal = Object.fromEntries(
    goals.map((g, i) => [g.id, contributions[i] ?? []]),
  );

  // Items the link picker offers: everything readable in scope, at any level,
  // since a goal can be served by an initiative or a single work item alike.
  const linkCandidates = allFeatures
    .filter((f) => inScope(f.productId) && f.status !== "archived")
    .map((f) => ({
      specId: f.specId,
      title: f.title,
      level: f.level,
      productId: f.productId,
    }));

  const scopedProducts =
    scope.kind === "group"
      ? products.filter((p) => scope.productIds.has(p.id))
      : products;

  return (
    <GoalsView
      goals={goals}
      contributionsByGoal={contributionsByGoal}
      linkCandidates={linkCandidates}
      canEdit={canEdit}
      org={org}
      productSlug={productSlug}
      levels={levels.map((l) => ({ key: l.key, label: l.label }))}
      defaultProductId={activeProduct?.id ?? null}
      products={scopedProducts.map((p) => ({ id: p.id, name: p.name }))}
      // Every readable goal, not just the ones in scope: a goal shown here can
      // be parented to one that is not, and the view has to be able to name it.
      // No leak, since listGoals is already filtered to what the caller can read.
      goalTitles={Object.fromEntries(allGoals.map((g) => [g.id, g.title]))}
    />
  );
}
