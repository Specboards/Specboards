import { revalidatePath } from "next/cache";

import { resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  canManageProductForScope,
  deleteProduct,
  parseProductPatch,
  updateProduct,
} from "@/lib/products-service";
import { ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const FORBIDDEN = Response.json(
  { error: "Only an organization admin or this product's admin can do this." },
  { status: 403 },
);

/** PATCH /api/v1/products/:id — update product settings. Product-admin only. */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  if (!(await canManageProductForScope(id, authz.scope ?? undefined)))
    return FORBIDDEN;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const product = await updateProduct(
      id,
      parseProductPatch(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap", "/[org]/settings/products"])
      revalidatePath(path, "page");
    return Response.json({ product });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/products/:id — remove a product (must have no items). */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  if (!(await canManageProductForScope(id, authz.scope ?? undefined)))
    return FORBIDDEN;

  try {
    await deleteProduct(id, authz.scope ?? undefined);
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap", "/[org]/settings/products"])
      revalidatePath(path, "page");
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
