import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getMembership, getWorkspaceById, updateWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const NAME_MAX = 80;

/**
 * PATCH /api/v1/workspace — update the caller's organization ("company")
 * details. Admin-only: changing the org name affects every member, so it's
 * gated above the general write role.
 */
export async function PATCH(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }
  if (membership.role !== "owner") {
    return Response.json(
      { error: "Only the owner can change company details." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const rawBody = (body ?? {}) as { name?: unknown };
  const name = typeof rawBody.name === "string" ? rawBody.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return Response.json(
      { error: `Company name is required (max ${NAME_MAX} characters).` },
      { status: 422 },
    );
  }

  const workspace = await updateWorkspace(db, membership.workspaceId, { name });
  if (!workspace) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  return Response.json({ workspace }, { status: 200 });
}

/**
 * GET /api/v1/workspace — the caller's organization details. Any member.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }

  const workspace = await getWorkspaceById(db, membership.workspaceId);
  if (!workspace) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  return Response.json({ workspace }, { status: 200 });
}
