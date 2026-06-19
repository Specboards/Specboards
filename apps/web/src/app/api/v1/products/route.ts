import { revalidatePath } from "next/cache";

import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  createProduct,
  listProducts,
  parseCreateProductInput,
} from "@/lib/products-service";
import { ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/products — products the caller can see, ordered by position. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const products = await listProducts(authz.scope ?? undefined);
  return Response.json({ products });
}

/** POST /api/v1/products — create a product. Organization-admin only. */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const product = await createProduct(
      parseCreateProductInput(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap", "/[org]/settings/products"])
      revalidatePath(path, "page");
    return Response.json({ product }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
