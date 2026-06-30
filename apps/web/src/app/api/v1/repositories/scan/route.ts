import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth-session";
import { scanWorkspaceSpecs } from "@/lib/github-sync";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/repositories/scan — read-only scan of every connected repo in the
 * caller's workspace for spec files, WITHOUT importing them. Powers the
 * onboarding "we found N specs, create cards?" prompt: it lists what would be
 * imported so the admin can confirm before any cards (or stable-id commits) are
 * created. Admin-only, since scanning uses the workspace's GitHub App access.
 */
export async function GET(req: Request) {
  const auth = await getSessionUser(req);
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "Repository scanning requires authentication." },
      { status: auth ? 501 : 401 },
    );
  }

  const membership = await getMembership(db, auth.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }
  if (membership.role !== "admin") {
    return Response.json({ error: "Only an admin can scan repositories." }, { status: 403 });
  }

  const repos = await scanWorkspaceSpecs(db, membership.workspaceId);
  const totalSpecs = repos.reduce((sum, r) => sum + r.specs.length, 0);
  return Response.json({ repos, totalSpecs });
}
