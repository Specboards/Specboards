import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, refuseApiKeyAuth } from "@/lib/auth-session";
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
 *
 * A `role` change additionally requires a browser session. Promoting somebody
 * to owner confers authority, and a leaked owner key that can promote an
 * account it controls has escalated into something revoking the key does not
 * undo. That is the same hole as inviting yourself back, one step to the side.
 *
 * `active` and DELETE stay reachable with a key on purpose: both take authority
 * away rather than conferring it, and a leaked key that could only deactivate
 * members has gained nothing it did not already have.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;
  const { userId } = await params;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { error: "Request body must be a JSON object." },
      { status: 400 },
    );
  }
  const raw = body as Record<string, unknown>;
  if (!("role" in raw) && !("active" in raw)) {
    return Response.json(
      { error: "Provide `role` and/or `active`." },
      { status: 400 },
    );
  }

  // Authorization first, then the extra restriction, because which one applies
  // is only knowable from the body. Ordered this way so an unauthenticated
  // caller still gets a 401 rather than a critique of their JSON.
  if ("role" in raw) {
    const denied = refuseApiKeyAuth(
      req,
      "A member's role is changed from a signed-in browser session, never with an API key.",
    );
    if (denied) return denied;
  }

  try {
    if ("role" in raw) {
      await setMemberRole(
        db,
        authz.scope.workspaceId,
        userId,
        parseRole(raw.role),
      );
    }
    if ("active" in raw) {
      if (typeof raw.active !== "boolean") {
        return Response.json(
          { error: "`active` must be a boolean." },
          { status: 400 },
        );
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
