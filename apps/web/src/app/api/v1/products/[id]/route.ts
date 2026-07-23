import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  canManageProductForScope,
  deleteProduct,
  listProducts,
  parseProductPatch,
  updateProduct,
} from "@/lib/products-service";
import { GroupError, ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const FORBIDDEN = Response.json(
  { error: "Only the workspace owner or this product's admin can do this." },
  { status: 403 },
);

/** GET /api/v1/products/:id — one product the caller can see, or 404. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  // listProducts already filters to products the caller may see, so a miss is
  // reported as 404 whether the id is unknown or simply not visible.
  const products = await listProducts(authz.scope ?? undefined);
  const product = products.find((p) => p.id === id);
  if (!product) {
    return Response.json({ error: "Product not found." }, { status: 404 });
  }
  return Response.json({ product });
}

/** PATCH /api/v1/products/:id — update product settings. Product-admin only. */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  if (!(await canManageProductForScope(id, authz.scope ?? undefined)))
    return FORBIDDEN;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const product = await updateProduct(
      id,
      parseProductPatch(body),
      authz.scope ?? undefined,
    );
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/[product]/roadmap",
      "/[org]/settings/products",
    ])
      revalidatePath(path, "page");
    return Response.json({ product });
  } catch (err) {
    if (
      err instanceof InvalidPatchError ||
      err instanceof ProductError ||
      err instanceof GroupError
    ) {
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
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/[product]/roadmap",
      "/[org]/settings/products",
    ])
      revalidatePath(path, "page");
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
