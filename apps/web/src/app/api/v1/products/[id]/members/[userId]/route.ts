import { resolveReadScope } from "@/lib/auth-session";
import {
  canManageProductForScope,
  removeProductMember,
} from "@/lib/products-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; userId: string }> };

/** DELETE /api/v1/products/:id/members/:userId — remove a member. Product-admin only. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id, userId } = await params;
  if (!(await canManageProductForScope(id, authz.scope ?? undefined))) {
    return Response.json(
      { error: "Only the workspace owner or this product's admin can do this." },
      { status: 403 },
    );
  }

  await removeProductMember(id, userId, authz.scope ?? undefined);
  return new Response(null, { status: 204 });
}
