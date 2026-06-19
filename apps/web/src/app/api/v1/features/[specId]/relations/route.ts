import { revalidatePath } from "next/cache";

import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  addFeatureRelation,
  FeatureNotFoundError,
  InvalidPatchError,
  parseRelationInput,
} from "@/lib/features-service";
import { getStore } from "@/lib/store";
import { RelationError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** GET /api/v1/features/:specId/relations — typed relations for a feature. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const store = await getStore();
  const feature = await store.getFeature(specId, authz.scope ?? undefined);
  if (!feature) {
    return Response.json({ error: `Unknown feature: ${specId}` }, { status: 404 });
  }
  return Response.json({ relations: feature.relations });
}

/**
 * POST /api/v1/features/:specId/relations — create a typed relation
 * ({ toSpecId, direction }). Returns the feature's refreshed relation list.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const relations = await addFeatureRelation(
      specId,
      parseRelationInput(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) revalidatePath(path, "page");
    revalidatePath("/[org]/[product]/backlog/[specId]", "page");
    return Response.json({ relations });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidPatchError || err instanceof RelationError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
