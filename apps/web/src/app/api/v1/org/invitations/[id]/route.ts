import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { revokeInvitation } from "@/lib/invitations-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const FILE_MODE = Response.json(
  { error: "Invitations are unavailable in local file mode." },
  { status: 400 },
);

/** DELETE /api/v1/org/invitations/:id — revoke a pending invitation. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;
  const { id } = await params;

  await revokeInvitation(db, authz.scope.workspaceId, id);
  return new Response(null, { status: 204 });
}
