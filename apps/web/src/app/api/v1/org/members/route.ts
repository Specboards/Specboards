import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { listMembers } from "@/lib/org-members-service";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const FILE_MODE = Response.json(
  { error: "Member management is unavailable in local file mode." },
  { status: 400 },
);

/**
 * GET /api/v1/org/members — the org's members. Organization-admin only. Full
 * list by default; pass `?limit` for opt-in cursor pagination (adds
 * `nextCursor`, preserves the name order).
 */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  let page;
  try {
    page = parsePageRequest(new URL(req.url));
  } catch (err) {
    if (err instanceof InvalidPageError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const list = await listMembers(db, authz.scope.workspaceId);
  if (page.limit === null) return Response.json({ members: list });

  const { items, nextCursor } = paginate(list, (m) => m.userId, page);
  return Response.json({ members: items, nextCursor });
}
