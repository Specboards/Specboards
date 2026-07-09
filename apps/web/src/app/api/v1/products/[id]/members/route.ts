import { resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/features-service";
import {
  canManageProductForScope,
  listProductMembers,
  parseProductMemberInput,
  setProductMember,
} from "@/lib/products-service";
import { ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const FORBIDDEN = Response.json(
  { error: "Only the workspace owner or this product's admin can do this." },
  { status: 403 },
);

/** GET /api/v1/products/:id/members — the product's members. Product-admin only. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  if (!(await canManageProductForScope(id, authz.scope ?? undefined)))
    return FORBIDDEN;

  const members = await listProductMembers(id, authz.scope ?? undefined);
  return Response.json({ members });
}

/** POST /api/v1/products/:id/members — add or update a member's role (upsert). */
export async function POST(req: Request, { params }: Params) {
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
    await setProductMember(
      id,
      parseProductMemberInput(body),
      authz.scope ?? undefined,
    );
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
