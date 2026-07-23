import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidPatchError,
  deleteIdea,
  parseIdeaPatch,
  updateIdea,
} from "@/lib/features-service";
import { revalidateIdeaPages } from "@/lib/revalidate-cards";
import { IdeaError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/ideas/:id - update an idea's title/description/status/product.
 * Requires write access to the idea's product.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const idea = await updateIdea(
      id,
      parseIdeaPatch(body),
      authz.scope ?? undefined,
    );
    revalidateIdeaPages();
    return Response.json({ idea });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof IdeaError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/ideas/:id - remove an idea (its votes cascade). */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteIdea(id, authz.scope ?? undefined);
    revalidateIdeaPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof IdeaError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
