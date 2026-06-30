import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth-session";
import { syncRepository, type SyncSummary } from "@/lib/github-sync";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repositories/import — import specs from every connected repo in
 * the workspace into the board, returning an aggregated summary. This is the
 * "create cards" confirmation behind the onboarding scan: it runs the same
 * reconcile as a re-sync, but across all repos at once. Admin-only, since the
 * import injects stable ids back into source repositories.
 */
export async function POST(req: Request) {
  const auth = await getSessionUser(req);
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "Importing specs requires authentication." },
      { status: auth ? 501 : 401 },
    );
  }

  const membership = await getMembership(db, auth.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }
  if (membership.role !== "admin") {
    return Response.json({ error: "Only an admin can import specs." }, { status: 403 });
  }

  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, membership.workspaceId));

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
