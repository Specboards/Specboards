import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ItemDetailView } from "@/components/item-detail-view";

import { ALL_PRODUCTS } from "@/lib/active-product";
import { getItemDetailData } from "@/lib/item-detail";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Item detail (full page). Renders the shared {@link ItemDetailView} — the same
 * layout the flyout uses — beneath the backlog breadcrumb. All the data it needs
 * is resolved once by {@link getItemDetailData}.
 *
 * The canonical permalink is `/{org}/{product}/backlog/{level}/{specId}` (ADR
 * 0002): the level key makes the item's type legible, and the specId is the
 * identity. We accept two shapes via this catch-all:
 *  - `[level, specId]` — render; redirect if the level segment is wrong.
 *  - `[specId]` — the old shallow permalink; 307-redirect to the typed shape.
 * A stale product segment also redirects to the item's current product (ADR
 * 0001 D5). Redirects are temporary — a feature can move products / its type is
 * derived per request — so the mapping must not be cached.
 */
export default async function ItemPage({
  params,
}: {
  params: Promise<{ org: string; product: string; slug: string[] }>;
}) {
  const access = await requireWorkspaceAccess();
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const { product, slug } = await params;

  // Parse the catch-all: one segment is a bare specId (old link); two are
  // [levelKey, specId]; anything else isn't an item route.
  let levelSeg: string | null;
  let specId: string;
  if (slug.length === 1) {
    levelSeg = null;
    specId = slug[0]!;
  } else if (slug.length === 2) {
    levelSeg = slug[0]!;
    specId = slug[1]!;
  } else {
    notFound();
  }

  const data = await getItemDetailData(specId, access);
  if (!data) notFound();
  const { feature } = data;

  // Canonicalize: the feature's current product is its context, and its level
  // key is the type segment. Redirect when either is stale/missing. `all` is
  // kept as-is so the cross-product view's links don't bounce on every click.
  const productStale = product !== data.productSlug && product !== ALL_PRODUCTS;
  if (productStale || levelSeg !== feature.level) {
    const targetProduct = product === ALL_PRODUCTS ? ALL_PRODUCTS : data.productSlug;
    redirect(
      orgProductPath(org, targetProduct, `/backlog/${feature.level}/${specId}`),
    );
  }
  const backlogHref = orgProductPath(org, product, "/backlog");

  return (
    <section className="mx-auto max-w-3xl">
      <Link
        href={backlogHref}
        className="text-xs text-muted-foreground hover:underline"
      >
        ← Backlog
      </Link>
      <div className="mt-3">
        <ItemDetailView data={data} variant="page" />
      </div>
    </section>
  );
}
