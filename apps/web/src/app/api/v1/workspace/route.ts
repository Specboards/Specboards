import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getWorkspaceById, updateWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const NAME_MAX = 80;

/**
 * PATCH /api/v1/workspace — update the caller's organization ("company")
 * details. Admin-only: changing the org name affects every member, so it's
 * gated above the general write role.
 */
export async function PATCH(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Editing the organization isn't available in local mode." },
      { status: 501 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const rawBody = (body ?? {}) as { name?: unknown };
  const name = typeof rawBody.name === "string" ? rawBody.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return Response.json(
      { error: `Company name is required (max ${NAME_MAX} characters).` },
      { status: 422 },
    );
  }

  const workspace = await updateWorkspace(db, authz.scope.workspaceId, {
    name,
  });
  if (!workspace) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  return Response.json({ workspace }, { status: 200 });
}

/**
 * GET /api/v1/workspace — the caller's organization details. Any member.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "No workspace in local mode." },
      { status: 404 },
    );
  }

  const workspace = await getWorkspaceById(db, authz.scope.workspaceId);
  if (!workspace) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  return Response.json({ workspace }, { status: 200 });
}
