import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { deleteGithubUserToken } from "@/lib/github-user-token";
import { resolveApiMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/github/user/connection — forget the caller's stored GitHub
 * token.
 *
 * Only ever the caller's own: the row is located by the session user's id, so
 * there is no id in the request that could name somebody else's connection.
 *
 * This deletes our copy. It does not revoke the grant on GitHub's side, which
 * only the user can do from their own account settings, and the UI says so
 * rather than letting "disconnected" imply more than it means.
 */
export async function DELETE(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const org = new URL(req.url).searchParams.get("org");
  const membership = await resolveApiMembership(db, user.id, org);
  if (!membership.ok) {
    return Response.json({ error: membership.error.code }, { status: 403 });
  }

  await deleteGithubUserToken(db, membership.membership.workspaceId, user.id);
  return Response.json({ ok: true });
}
