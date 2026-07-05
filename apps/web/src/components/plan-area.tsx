import Link from "next/link";
import { notFound } from "next/navigation";

import { DocAreaBody } from "@/components/doc-area-body";
import { DocsWorkspace } from "@/components/docs-workspace";
import { ALL_PRODUCTS, resolveActiveProduct } from "@/lib/active-product";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import type { DocArea } from "@/lib/store/types";
import { canWrite } from "@/lib/workspace";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

const AREA_COPY: Record<
  DocArea,
  {
    label: string;
    blurb: string;
    starterTitles: string[];
    emptyHint: string;
    /** Whether the team picks a doc source first (external / Specboard / GitHub). */
    chooseSource: boolean;
  }
> = {
  strategy: {
    label: "Strategy",
    blurb: "Why this product exists, what the current targets are, and how the team is building.",
    starterTitles: ["Overview", "Goals", "How we build"],
    emptyHint:
      "Define the product overview, goals, and operating principles the team works from.",
    chooseSource: false,
  },
  research: {
    label: "Research",
    blurb: "The discovery work behind the product: interviews, findings, and synthesis.",
    starterTitles: [],
    emptyHint: "Capture interviews, findings, and synthesis as pages and folders.",
    chooseSource: true,
  },
  architecture: {
    label: "Architecture",
    blurb: "Constitution files for spec-driven development, service architecture, and contracts.",
    starterTitles: ["Constitution", "Service architecture", "Contracts"],
    emptyHint:
      "Define the engineering constitution, service boundaries, and the contracts between them.",
    chooseSource: true,
  },
};

/**
 * Shared server view for the Plan-section areas (Strategy / Research /
 * Architecture). Resolves the product from the URL; the cross-product "all"
 * segment prompts for a product since docs are per-product. Strategy is
 * always Specboard-held pages; the other areas choose a source first.
 */
export async function PlanAreaView({
  area,
  productSlug,
}: {
  area: DocArea;
  productSlug: string;
}) {
  const copy = AREA_COPY[area];
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const store = await getStore();
  const products = await store.listProducts(access ?? undefined);

  let product = resolveActiveProduct(products, productSlug);
  if (!product) {
    if (productSlug !== ALL_PRODUCTS) notFound();
    if (products.length === 1) product = products[0] ?? null;
  }

  if (!product) {
    return (
      <section className="space-y-4">
        <AreaHeader copy={copy} />
        <div className="mx-auto max-w-md space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {copy.label} is per product. Pick one:
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {products.map((p) => (
              <Link
                key={p.id}
                href={orgProductPath(org, p.key, `/${area}`)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                {p.name}
              </Link>
            ))}
          </div>
        </div>
      </section>
    );
  }

  const [space, pages] = await Promise.all([
    store.getDocSpace(product.id, area, access ?? undefined),
    store.listDocPages(product.id, area, access ?? undefined),
  ]);

  return (
    <section className="flex min-h-0 flex-1 flex-col space-y-4">
      <AreaHeader copy={copy} />
      {copy.chooseSource ? (
        <DocAreaBody
          space={space}
          pages={pages}
          areaLabel={copy.label}
          canEdit={canEdit}
          starterTitles={copy.starterTitles}
          emptyHint={copy.emptyHint}
        />
      ) : (
        <DocsWorkspace
          productId={product.id}
          area={area}
          initialPages={pages}
          canEdit={canEdit}
          starterTitles={copy.starterTitles}
          emptyHint={copy.emptyHint}
        />
      )}
    </section>
  );
}

function AreaHeader({ copy }: { copy: (typeof AREA_COPY)[DocArea] }) {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{copy.label}</h1>
      <p className="text-sm text-muted-foreground">{copy.blurb}</p>
    </div>
  );
}
