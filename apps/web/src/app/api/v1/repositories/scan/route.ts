import { getDb } from "@/lib/db";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { scanWorkspaceSpecs } from "@/lib/github-sync";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/repositories/scan — read-only scan of every connected repo in the
 * caller's workspace for spec files, WITHOUT importing them. Powers the
 * onboarding "we found N specs, create cards?" prompt: it lists what would be
 * imported so the admin can confirm before any cards (or stable-id commits) are
 * created. Admin-only, since scanning uses the workspace's GitHub App access.
 */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Repository scanning isn't available in local mode." },
      { status: 501 },
    );
  }

  const limited = await enforceQuota(db, QUOTAS.scan, authz.scope.workspaceId);
  if (limited) return limited;

  const repos = await scanWorkspaceSpecs(db, authz.scope.workspaceId);
  const totalSpecs = repos.reduce((sum, r) => sum + r.specs.length, 0);
  return Response.json({ repos, totalSpecs });
}
