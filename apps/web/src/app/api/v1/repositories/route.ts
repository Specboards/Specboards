import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { getSessionUser, resolveReadScope } from "@/lib/auth-session";
import { syncRepository, type SyncSummary } from "@/lib/github-sync";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** GET /api/v1/repositories — connected repos in the caller's workspace. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  // Local file mode (no DB / no scope): no repos to list.
  if (!db || !authz.scope) return Response.json({ repositories: [] });

  const rows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, authz.scope.workspaceId));
  return Response.json({ repositories: rows });
}

interface RegisterBody {
  installationId: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  specGlobs?: string[];
}

/** Validate the untrusted registration body. */
function parseRegisterBody(body: unknown): RegisterBody | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  const installationId = str(raw.installationId);
  const owner = str(raw.owner);
  const name = str(raw.name);
  if (!installationId || !owner || !name) return null;

  const defaultBranch = str(raw.defaultBranch) ?? undefined;
  let specGlobs: string[] | undefined;
  if (raw.specGlobs !== undefined) {
    if (!Array.isArray(raw.specGlobs) || raw.specGlobs.some((g) => typeof g !== "string")) {
      return null;
    }
    specGlobs = (raw.specGlobs as string[]).map((g) => g.trim()).filter(Boolean);
  }

  return { installationId, owner, name, defaultBranch, specGlobs };
}

/**
 * POST /api/v1/repositories — connect a GitHub repo to the workspace, then run
 * an initial spec import. Admin-only: connecting a repo wires up automated
 * commits (stable-id injection) into someone's source tree.
 */
export async function POST(req: Request) {
  const auth = await getSessionUser(req);
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "Repository management requires authentication." },
      { status: auth ? 501 : 401 },
    );
  }

  const membership = await getMembership(db, auth.id);
  if (!membership) {
    return Response.json({ error: "You do not belong to a workspace." }, { status: 403 });
  }
  if (membership.role !== "admin") {
    return Response.json({ error: "Only an admin can connect repositories." }, { status: 403 });
  }

  const parsed = parseRegisterBody(await req.json().catch(() => null));
  if (!parsed) {
    return Response.json(
      { error: "Body must include installationId, owner, and name." },
      { status: 400 },
    );
  }

  const config = parsed.specGlobs ? { version: 1, specGlobs: parsed.specGlobs } : null;
  const [repo] = await db
    .insert(repositories)
    .values({
      workspaceId: membership.workspaceId,
      githubInstallationId: parsed.installationId,
      owner: parsed.owner,
      name: parsed.name,
      defaultBranch: parsed.defaultBranch ?? "main",
      config,
    })
    .onConflictDoUpdate({
      target: [repositories.workspaceId, repositories.owner, repositories.name],
      set: {
        githubInstallationId: parsed.installationId,
        defaultBranch: parsed.defaultBranch ?? "main",
        ...(config ? { config } : {}),
      },
    })
    .returning();
  if (!repo) return Response.json({ error: "Failed to connect repository." }, { status: 500 });

  // Kick an initial import. Don't fail the connection if it errors (e.g. the
  // App isn't installed on the repo yet) — surface it so the UI can retry.
  let sync: SyncSummary | { error: string };
  try {
    sync = await syncRepository(db, repo);
  } catch (err) {
    console.error(`[repositories] initial sync failed for ${repo.owner}/${repo.name}:`, err);
    sync = { error: err instanceof Error ? err.message : "Initial sync failed." };
  }

  return Response.json({ repository: repo, sync }, { status: 201 });
}
