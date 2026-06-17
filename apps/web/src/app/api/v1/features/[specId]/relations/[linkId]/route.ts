import { revalidatePath } from "next/cache";

import { authorizeWrite } from "@/lib/auth-session";
import {
  FeatureNotFoundError,
  InvalidPatchError,
  removeFeatureRelation,
} from "@/lib/features-service";
import { RelationError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string; linkId: string }> };

/** DELETE /api/v1/features/:specId/relations/:linkId — remove a relation. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId, linkId } = await params;

  try {
    const relations = await removeFeatureRelation(
      specId,
      decodeURIComponent(linkId),
      authz.scope ?? undefined,
    );
    for (const path of ["/backlog", "/board", "/roadmap"]) revalidatePath(path);
    revalidatePath("/feature/[id]", "page");
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
