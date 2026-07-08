import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { listMembers } from "@/lib/org-members-service";

export const dynamic = "force-dynamic";

const FILE_MODE = Response.json(
  { error: "Member management is unavailable in local file mode." },
  { status: 400 },
);

/** GET /api/v1/org/members — the org's members. Organization-admin only. */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  const list = await listMembers(db, authz.scope.workspaceId);
  return Response.json({ members: list });
}
