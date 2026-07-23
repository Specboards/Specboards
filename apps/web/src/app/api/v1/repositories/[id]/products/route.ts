import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { InvalidPatchError } from "@/lib/features-service";
import {
  listRepoProductLinks,
  parseRepoProductsInput,
  RepoLinkError,
  setRepoProducts,
} from "@/lib/repo-links-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/repositories/:id/products — the repo's product links. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const db = getDb();
  // Local file mode: repos aren't a concept, nothing to link.
  if (!db || !authz.scope) {
    return Response.json({
      repoId: id,
      productIds: [],
      defaultProductId: null,
    });
  }
  const links = await listRepoProductLinks(db, authz.scope.workspaceId);
  return Response.json(
    links.get(id) ?? { repoId: id, productIds: [], defaultProductId: null },
  );
}

/** PUT /api/v1/repositories/:id/products — replace the repo's product links
 * and default product. Organization-admin only, like connecting a repo. */
export async function PUT(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const db = getDb();
  if (!db || !authz.scope) {
    return Response.json(
      {
        error:
          "Repository links need a database (not available in local file mode).",
      },
      { status: 400 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const links = await setRepoProducts(
      db,
      authz.scope.workspaceId,
      id,
      parseRepoProductsInput(body),
    );
    return Response.json(links);
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof RepoLinkError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
