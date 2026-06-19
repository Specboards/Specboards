import { revalidatePath } from "next/cache";

import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  FeatureNotFoundError,
  InvalidPatchError,
  deleteWorkItem,
  parseFeaturePatch,
  patchFeature,
} from "@/lib/features-service";
import { getStore } from "@/lib/store";
import { FeatureError, RelationError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** GET /api/v1/features/:specId — full feature detail (metadata + spec content). */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const store = await getStore();
  const feature = await store.getFeature(specId, authz.scope ?? undefined);
  if (!feature) {
    return Response.json({ error: `Unknown feature: ${specId}` }, { status: 404 });
  }
  return Response.json({ feature });
}

/**
 * PATCH /api/v1/features/:specId — update PM metadata (status / priority /
 * roadmapQuarter / tags / assigneeId / customFields). Status changes are
 * validated against the workflow state machine.
 */
export async function PATCH(req: Request, { params }: Params) {
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
    const feature = await patchFeature(
      specId,
      parseFeaturePatch(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) revalidatePath(path, "page");
    revalidatePath("/[org]/[product]/backlog/[specId]", "page");
    return Response.json({ feature });
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

/**
 * DELETE /api/v1/features/:specId — delete a DB-native work item
 * (initiative/epic). Spec-backed items can't be deleted here (the store
 * rejects them); their children are orphaned, not cascade-deleted.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  try {
    await deleteWorkItem(specId, authz.scope ?? undefined);
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) revalidatePath(path, "page");
    revalidatePath("/[org]/[product]/backlog/[specId]", "page");
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof FeatureError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
