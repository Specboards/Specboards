import { repositories } from "@specboard/db";
import {
  createInstallationOrgRepository,
  getInstallationAccount,
  type CreatedRepo,
} from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isE2E } from "@/lib/e2e";
import { getGithubApp } from "@/lib/github-app";
import { loadWorkspaceInstallations, resolveWorkspaceInstallation } from "@/lib/github-connect";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/github/installations/repositories: the workspace's GitHub App
 * installations and the repos each can access, for the connect picker. The
 * installations come from `github_installations` (bound by the setup callback,
 * not client-supplied), so this only ever lists installations the workspace's
 * admins actually performed.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "owner") {
    return Response.json({ error: "Only the owner can connect repositories." }, { status: 403 });
  }

  const state = await loadWorkspaceInstallations(db, membership.workspaceId);
  return Response.json(state);
}

/** GitHub repository names: word characters, dots, and hyphens. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Turn a failed create-repo call into a message the admin can act on. */
function createRepoErrorMessage(err: unknown, name: string, org: string): string {
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : null;
  if (status === 422) {
    return `GitHub rejected the repository (a repo called "${name}" may already exist in ${org}).`;
  }
  if (status === 403 || status === 404) {
    return (
      "The Specboard GitHub App isn't allowed to create repositories yet. " +
      "Approve its updated permissions (repository Administration) on GitHub, then try again."
    );
  }
  return "GitHub couldn't create the repository. Please try again.";
}

/**
 * POST /api/v1/github/installations/repositories: create a private spec repo
 * in one of the workspace's organization installations and connect it. The
 * one-click alternative to the "create a repo on GitHub, install the App,
 * connect it here" instructions. Admin-only; the target installation must be
 * bound to the workspace in `github_installations`.
 * Body: { name, installationId? } (installationId may be omitted when the
 * workspace has exactly one organization installation).
 *
 * Only works for organization installations: GitHub has no installation-token
 * endpoint that creates repos under a personal account, so those users keep
 * the manual flow.
 */
export async function POST(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "owner") {
    return Response.json({ error: "Only the owner can create repositories." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const requestedInstallation =
    typeof body?.installationId === "string" && body.installationId.trim() !== ""
      ? body.installationId.trim()
      : null;
  if (!REPO_NAME_RE.test(name) || name === "." || name === "..") {
    return Response.json(
      { error: "Repository names can use letters, numbers, dots, hyphens, and underscores." },
      { status: 400 },
    );
  }

  const installation = await resolveWorkspaceInstallation(
    db,
    membership.workspaceId,
    requestedInstallation,
  );
  if (!installation) {
    return Response.json(
      { error: "Connect GitHub first, then come back here to create the repo." },
      { status: 403 },
    );
  }
  if (installation.accountType !== "Organization") {
    return Response.json(
      {
        error:
          "GitHub only lets the App create repositories in an organization. " +
          "For a personal account, create the repo on GitHub and install the App on it.",
      },
      { status: 400 },
    );
  }

  let created: CreatedRepo;
  if (isE2E()) {
    // Hermetic E2E: no GitHub. The "created" repo simply doesn't exist in the
    // fixture yet, which is exactly what a fresh empty repo scans as.
    created = {
      owner: installation.accountLogin,
      name,
      defaultBranch: "main",
      private: true,
      htmlUrl: `https://github.com/${installation.accountLogin}/${name}`,
    };
  } else {
    const app = await getGithubApp(db);
    if (!app) {
      return Response.json({ error: "GitHub App is not configured." }, { status: 501 });
    }

    // Live lookup rather than the stored login: survives org renames, and
    // re-validates the installation still exists on GitHub.
    let account;
    try {
      account = await getInstallationAccount(app, installation.installationId);
    } catch (err) {
      console.error("[github] failed to resolve installation account:", err);
      return Response.json(
        { error: "Couldn't look up the GitHub installation. Please try again." },
        { status: 502 },
      );
    }
    if (account.type !== "Organization") {
      return Response.json(
        { error: "GitHub only lets the App create repositories in an organization." },
        { status: 400 },
      );
    }

    try {
      created = await createInstallationOrgRepository(app, installation.installationId, {
        org: account.login,
        name,
        description: "Product specs synced to Specboard",
      });
    } catch (err) {
      console.error(`[github] failed to create repository ${account.login}/${name}:`, err);
      return Response.json(
        { error: createRepoErrorMessage(err, name, account.login) },
        { status: 502 },
      );
    }
  }

  // Register it as a connected repo, same shape as the connect flow. Upsert so
  // retrying after a partial failure converges instead of erroring.
  const [repo] = await db
    .insert(repositories)
    .values({
      workspaceId: membership.workspaceId,
      githubInstallationId: installation.installationId,
      owner: created.owner,
      name: created.name,
      defaultBranch: created.defaultBranch,
      isSpecRepo: true,
    })
    .onConflictDoUpdate({
      target: [repositories.workspaceId, repositories.owner, repositories.name],
      set: {
        githubInstallationId: installation.installationId,
        defaultBranch: created.defaultBranch,
        isSpecRepo: true,
      },
    })
    .returning();
  if (!repo) {
    return Response.json(
      { error: `Created ${created.owner}/${created.name} on GitHub but couldn't connect it. Connect it from the picker above.` },
      { status: 500 },
    );
  }

  return Response.json(
    {
      repository: {
        id: repo.id,
        owner: created.owner,
        name: created.name,
        defaultBranch: created.defaultBranch,
        htmlUrl: created.htmlUrl,
      },
    },
    { status: 201 },
  );
}
