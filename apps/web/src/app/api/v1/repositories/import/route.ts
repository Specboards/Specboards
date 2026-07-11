import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { syncRepository, type SyncSummary } from "@/lib/github-sync";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repositories/import — import specs from every connected repo in
 * the workspace into the board, returning an aggregated summary. This is the
 * "create cards" confirmation behind the onboarding scan: it runs the same
 * reconcile as a re-sync, but across all repos at once. Admin-only, since the
 * import injects stable ids back into source repositories.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Importing specs isn't available in local mode." },
      { status: 501 },
    );
  }

  const limited = await enforceQuota(db, QUOTAS.import, authz.scope.workspaceId);
  if (limited) return limited;

  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, authz.scope.workspaceId));

  const total: SyncSummary = { upserted: 0, skipped: 0, idsInjected: 0, featuresCreated: 0 };
  const errors: { owner: string; name: string; error: string }[] = [];

  for (const repo of repos) {
    try {
      const summary = await syncRepository(db, repo);
      total.upserted += summary.upserted;
      total.skipped += summary.skipped;
      total.idsInjected += summary.idsInjected;
      total.featuresCreated += summary.featuresCreated;
    } catch (err) {
      console.error(`[repositories/import] sync failed for ${repo.owner}/${repo.name}:`, err);
      errors.push({
        owner: repo.owner,
        name: repo.name,
        error: err instanceof Error ? err.message : "Import failed.",
      });
    }
  }

  return Response.json({ summary: total, errors });
}
