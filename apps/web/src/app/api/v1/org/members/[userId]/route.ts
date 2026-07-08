import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  OrgMemberError,
  parseRole,
  removeMember,
  setMemberActive,
  setMemberRole,
} from "@/lib/org-members-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

const FILE_MODE = Response.json(
  { error: "Member management is unavailable in local file mode." },
  { status: 400 },
);

/**
 * PATCH /api/v1/org/members/:userId — change a member's `role` and/or `active`
 * flag. Organization-admin only. Refuses to demote/deactivate the last admin.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;
  const { userId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;
  if (!("role" in raw) && !("active" in raw)) {
    return Response.json({ error: "Provide `role` and/or `active`." }, { status: 400 });
  }

  try {
    if ("role" in raw) {
      await setMemberRole(db, authz.scope.workspaceId, userId, parseRole(raw.role));
    }
    if ("active" in raw) {
      if (typeof raw.active !== "boolean") {
        return Response.json({ error: "`active` must be a boolean." }, { status: 400 });
      }
      await setMemberActive(db, authz.scope.workspaceId, userId, raw.active);
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof OrgMemberError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/org/members/:userId — remove a member. Last-admin protected. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;
  const { userId } = await params;

  try {
    await removeMember(db, authz.scope.workspaceId, userId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof OrgMemberError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
