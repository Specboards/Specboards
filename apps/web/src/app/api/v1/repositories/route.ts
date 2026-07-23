import { and, eq, repositories } from "@specboards/db";
import { listInstallationRepositories } from "@specboards/git";

import { readJsonBody } from "@/lib/api/body";
import { getDb } from "@/lib/db";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import { getGithubApp } from "@/lib/github-app";
import { resolveWorkspaceInstallation } from "@/lib/github-connect";
import { syncRepository, type SyncSummary } from "@/lib/github-sync";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** GET /api/v1/repositories: connected repos in the caller's workspace. */
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
  /** Run the initial spec import after connecting. Defaults to true. */
  sync: boolean;
}

/** Validate the untrusted registration body. */
function parseRegisterBody(body: unknown): RegisterBody | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const installationId = str(raw.installationId);
  const owner = str(raw.owner);
  const name = str(raw.name);
  if (!installationId || !owner || !name) return null;

  const defaultBranch = str(raw.defaultBranch) ?? undefined;
  let specGlobs: string[] | undefined;
  if (raw.specGlobs !== undefined) {
    if (
      !Array.isArray(raw.specGlobs) ||
      raw.specGlobs.some((g) => typeof g !== "string")
    ) {
      return null;
    }
    specGlobs = (raw.specGlobs as string[])
      .map((g) => g.trim())
      .filter(Boolean);
  }

  // Connecting defaults to importing immediately (re-sync, manual connect). The
  // onboarding flow passes `sync: false` to register the repo and defer the
  // import behind an explicit "create cards" confirmation.
  const sync = raw.sync === false ? false : true;

  return { installationId, owner, name, defaultBranch, specGlobs, sync };
}

/**
 * POST /api/v1/repositories: connect a GitHub repo to the workspace, then run
 * an initial spec import. Admin-only: connecting a repo wires up automated
 * commits (stable-id injection) into someone's source tree.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Repository management isn't available in local mode." },
      { status: 501 },
    );
  }
  const workspaceId = authz.scope.workspaceId;

  const limited = await enforceQuota(db, QUOTAS.connectRepo, workspaceId);
  if (limited) return limited;

  const parsedBody = await readJsonBody(req);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = parseRegisterBody(parsedBody.body);
  if (!parsed) {
    return Response.json(
      { error: "Body must include installationId, owner, and name." },
      { status: 400 },
    );
  }

  const existing = await db.query.repositories.findFirst({
    where: and(
      eq(repositories.workspaceId, workspaceId),
      eq(repositories.owner, parsed.owner),
      eq(repositories.name, parsed.name),
    ),
  });
  const connectedRepo = existing ?? null;

  if (
    !connectedRepo ||
    connectedRepo.githubInstallationId !== parsed.installationId
  ) {
    // The installation must be one bound to this workspace by the install
    // setup callback, so a client-supplied (guessable) id is never trusted.
    const installation = await resolveWorkspaceInstallation(
      db,
      workspaceId,
      parsed.installationId,
    );
    if (!installation) {
      return Response.json(
        { error: "Install the GitHub App before connecting this repository." },
        { status: 403 },
      );
    }

    const app = await getGithubApp(db);
    if (!app) {
      return Response.json(
        { error: "GitHub App is not configured." },
        { status: 501 },
      );
    }
    const granted = await listInstallationRepositories(
      app,
      parsed.installationId,
    );
    const match = granted.find(
      (repo) =>
        repo.owner.toLowerCase() === parsed.owner.toLowerCase() &&
        repo.name.toLowerCase() === parsed.name.toLowerCase(),
    );
    if (!match) {
      return Response.json(
        { error: "The GitHub App installation cannot access that repository." },
        { status: 403 },
      );
    }
    parsed.defaultBranch = match.defaultBranch;
  }

  const config = parsed.specGlobs
    ? { version: 1, specGlobs: parsed.specGlobs }
    : null;
  const [repo] = await db
    .insert(repositories)
    .values({
      workspaceId: workspaceId,
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
  if (!repo)
    return Response.json(
      { error: "Failed to connect repository." },
      { status: 500 },
    );

  // Kick an initial import unless the caller deferred it (onboarding scan flow).
  // Don't fail the connection if it errors (e.g. the App isn't installed on the
  // repo yet), surface it so the UI can retry.
  let sync: SyncSummary | { error: string } | null = null;
  if (parsed.sync) {
    try {
      sync = await syncRepository(db, repo);
    } catch (err) {
      console.error(
        `[repositories] initial sync failed for ${repo.owner}/${repo.name}:`,
        err,
      );
      sync = {
        error: err instanceof Error ? err.message : "Initial sync failed.",
      };
    }
  }

  return Response.json({ repository: repo, sync }, { status: 201 });
}
