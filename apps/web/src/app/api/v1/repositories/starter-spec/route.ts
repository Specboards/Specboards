import { and, eq, repositories } from "@specboards/db";

import { readJsonBody } from "@/lib/api/body";
import { getDb } from "@/lib/db";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { createStarterSpec } from "@/lib/github-sync";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repositories/starter-spec — commit a starter `spec.md` into a
 * connected repo and import it, so a workspace with no specs yet can create its
 * first one and feel the full loop. Admin-only, since it commits to source.
 * Body: { repoId, featureName }.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Creating a starter spec isn't available in local mode." },
      { status: 501 },
    );
  }

  const limited = await enforceQuota(
    db,
    QUOTAS.starterSpec,
    authz.scope.workspaceId,
  );
  if (limited) return limited;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body as Record<string, unknown> | null;
  const repoId = typeof body?.repoId === "string" ? body.repoId.trim() : "";
  const featureName =
    typeof body?.featureName === "string" ? body.featureName.trim() : "";
  if (!repoId || !featureName) {
    return Response.json(
      { error: "repoId and featureName are required." },
      { status: 400 },
    );
  }

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repoId),
        eq(repositories.workspaceId, authz.scope.workspaceId),
      ),
    )
    .limit(1);
  if (!repo) {
    return Response.json(
      { error: "Repository not found in your workspace." },
      { status: 404 },
    );
  }

  try {
    const result = await createStarterSpec(db, repo, featureName);
    return Response.json(result, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Couldn't create the starter spec.";
    return Response.json({ error: message }, { status: 400 });
  }
}
