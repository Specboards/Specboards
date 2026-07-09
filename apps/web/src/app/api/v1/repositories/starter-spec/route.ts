import { and, eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/auth-session";
import { createStarterSpec } from "@/lib/github-sync";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/repositories/starter-spec — commit a starter `spec.md` into a
 * connected repo and import it, so a workspace with no specs yet can create its
 * first one and feel the full loop. Admin-only, since it commits to source.
 * Body: { repoId, featureName }.
 */
export async function POST(req: Request) {
  const auth = await getSessionUser(req);
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "Creating a starter spec requires authentication." },
      { status: auth ? 501 : 401 },
    );
  }

  const membership = await getMembership(db, auth.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }
  if (membership.role !== "owner") {
    return Response.json({ error: "Only the owner can create a starter spec." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const repoId = typeof body?.repoId === "string" ? body.repoId.trim() : "";
  const featureName = typeof body?.featureName === "string" ? body.featureName.trim() : "";
  if (!repoId || !featureName) {
    return Response.json({ error: "repoId and featureName are required." }, { status: 400 });
  }

  const [repo] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repoId), eq(repositories.workspaceId, membership.workspaceId)))
    .limit(1);
  if (!repo) {
    return Response.json({ error: "Repository not found in your workspace." }, { status: 404 });
  }

  try {
    const result = await createStarterSpec(db, repo, featureName);
    return Response.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't create the starter spec.";
    return Response.json({ error: message }, { status: 400 });
  }
}
