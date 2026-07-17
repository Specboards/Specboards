import { revalidatePath } from "next/cache";

import { authorizeOrgAdmin } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  deleteProductGroup,
  parseProductGroupPatch,
  updateProductGroup,
} from "@/lib/product-groups-service";
import { GroupError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const REVALIDATE = ["/[org]/[product]/backlog", "/[org]/[product]/roadmap", "/[org]/settings/products"];

/** PATCH /api/v1/product-groups/:id — update a group. Org-admin only. */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const group = await updateProductGroup(
      id,
      parseProductGroupPatch(body),
      authz.scope ?? undefined,
    );
    for (const path of REVALIDATE) revalidatePath(path, "page");
    return Response.json({ group });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof GroupError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/product-groups/:id — remove an empty group. Org-admin only. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    await deleteProductGroup(id, authz.scope ?? undefined);
    for (const path of REVALIDATE) revalidatePath(path, "page");
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof GroupError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
