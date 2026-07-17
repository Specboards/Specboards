import Link from "next/link";
import { notFound } from "next/navigation";

import { eq, githubInstallations } from "@specboard/db";

import { DocAreaBody, type GithubDocsData } from "@/components/doc-area-body";
import type { GithubSetupState } from "@/components/doc-space-setup";
import { DocsWorkspace } from "@/components/docs-workspace";
import { resolveActiveScope } from "@/lib/active-product";
import { getDb } from "@/lib/db";
import { loadGithubDocs } from "@/lib/github-docs";
import { LOCAL_ORG_SLUG, orgPath, orgProductPath } from "@/lib/org-path";
import { getStore } from "@/lib/store";
import type { DocArea } from "@/lib/store/types";
import { canEditProducts, requireWorkspaceAccess } from "@/lib/workspace-access";

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
  const org = access?.orgSlug ?? LOCAL_ORG_SLUG;
  const store = await getStore();
  const [products, groups] = await Promise.all([
    store.listProducts(access ?? undefined),
    store.listProductGroups(access ?? undefined),
  ]);

  const scope = resolveActiveScope(products, groups, productSlug);
  if (!scope) notFound();
  let product = scope.kind === "product" ? scope.product : null;
  // Docs are per-product: in the "all" (or a single-product group) scope with
  // exactly one candidate, use it; otherwise prompt for a product below.
  const candidates =
    scope.kind === "group"
      ? products.filter((p) => scope.productIds.has(p.id))
      : products;
  if (!product && candidates.length === 1) product = candidates[0] ?? null;

  if (!product) {
    return (
      <section className="space-y-4">
        <AreaHeader copy={copy} />
        <div className="mx-auto max-w-md space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {copy.label} is per product. Pick one:
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {candidates.map((p) => (
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

  // Editing this area's docs follows the product's edit permission.
  const canEdit = canEditProducts(access, products, product.id);

  const [space, pages] = await Promise.all([
    store.getDocSpace(product.id, area, access ?? undefined),
    store.listDocPages(product.id, area, access ?? undefined),
  ]);

  // What the chooser's GitHub option can offer here: repo creation needs a
  // DB-backed deployment, an org installation, and a workspace admin.
  const db = getDb();
  let githubAvailable = false;
  if (db && access) {
    const [installation] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, access.workspaceId))
      .limit(1);
    githubAvailable = Boolean(installation);
  }
  const githubSetup: GithubSetupState = {
    available: githubAvailable,
    isAdmin: !access || access.role === "owner",
    suggestedName: `${product.key}-${area}`,
    installHref: orgPath(org, "/repositories"),
  };

  // GitHub-backed spaces resolve their repo + files server-side; failures
  // (repo deleted, GitHub down, local file mode) render as a friendly card.
  let github: GithubDocsData | undefined;
  if (space.mode === "github") {
    if (!db || !access) {
      github = { error: "GitHub-backed docs need a database-backed deployment." };
    } else {
      try {
        const loaded = await loadGithubDocs(db, access.workspaceId, space);
        github = {
          repoFullName: `${loaded.repo.owner}/${loaded.repo.name}`,
          repoUrl: loaded.repo.htmlUrl,
          files: loaded.files,
        };
      } catch (err) {
        github = {
          error:
            err instanceof Error ? err.message : "The repository is unavailable.",
        };
      }
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col space-y-4">
      <AreaHeader copy={copy} />
      {copy.chooseSource ? (
        <DocAreaBody
          space={space}
          pages={pages}
          github={github}
          githubSetup={githubSetup}
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
