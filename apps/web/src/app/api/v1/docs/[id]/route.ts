import { authorizeWrite } from "@/lib/auth-session";
import {
  deleteDocPage,
  parseDocPagePatch,
  updateDocPage,
} from "@/lib/docs-service";
import { DocError, ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/docs/:id - rename, edit content, or move to another folder.
 * Requires write access to the page's product.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const page = await updateDocPage(id, parseDocPagePatch(body), authz.scope ?? undefined);
    return Response.json({ page });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/docs/:id - remove a page, or a folder and its contents. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteDocPage(id, authz.scope ?? undefined);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
