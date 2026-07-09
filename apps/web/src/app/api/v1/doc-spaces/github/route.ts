import { repositories } from "@specboard/db";
import {
  createInstallationOrgRepository,
  getInstallationAccount,
  listInstallationRepositories,
  type CreatedRepo,
} from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { parseDocArea } from "@/lib/docs-service";
import { isE2E } from "@/lib/e2e";
import { getGithubApp } from "@/lib/github-app";
import { resolveWorkspaceInstallation } from "@/lib/github-connect";
import { getStore } from "@/lib/store";
import { DocError, ProductError } from "@/lib/store/types";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

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
 * POST /api/v1/doc-spaces/github: bind a GitHub repository as the area's doc
 * source, either by creating a private repo in the workspace's organization
 * installation (body: { productId, area, name, installationId? }) or by
 * connecting one the installation can already access (body: { productId,
 * area, existing: { owner, name }, installationId? }). Mirrors the spec-repo
 * flows (admin-only; creation needs an org installation), but the row is
 * written with `isSpecRepo: false` and no config so spec sync never touches
 * it. Connecting a repo that's already registered (even as a spec repo)
 * reuses its row untouched.
 */
export async function POST(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "owner") {
    return Response.json(
      { error: "Only the owner can connect repositories." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const productId = typeof body?.productId === "string" ? body.productId : "";
  const requestedInstallation =
    typeof body?.installationId === "string" && body.installationId.trim() !== ""
      ? body.installationId.trim()
      : null;
  const existing =
    typeof body?.existing === "object" && body.existing !== null
      ? (body.existing as Record<string, unknown>)
      : null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!existing && (!REPO_NAME_RE.test(name) || name === "." || name === "..")) {
    return Response.json(
      { error: "Repository names can use letters, numbers, dots, hyphens, and underscores." },
      { status: 400 },
    );
  }

  let area;
  try {
    area = parseDocArea(body?.area);
  } catch (err) {
    if (err instanceof DocError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const installation = await resolveWorkspaceInstallation(
    db,
    membership.workspaceId,
    requestedInstallation,
  );
  if (!installation) {
    return Response.json(
      { error: "Connect GitHub first, then come back here to pick the repo." },
      { status: 403 },
    );
  }

  if (existing) {
    return connectExistingRepo({
      db,
      userId: user.id,
      workspaceId: membership.workspaceId,
      installation,
      productId,
      area,
      owner: typeof existing.owner === "string" ? existing.owner.trim() : "",
      name: typeof existing.name === "string" ? existing.name.trim() : "",
    });
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
    // fixture yet, which is exactly what a fresh empty repo lists as.
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
        description: `${area === "architecture" ? "Architecture" : "Research"} docs, edited in Specboard`,
      });
    } catch (err) {
      console.error(`[github] failed to create repository ${account.login}/${name}:`, err);
      return Response.json(
        { error: createRepoErrorMessage(err, name, account.login) },
        { status: 502 },
      );
    }
  }

  return bindDocRepo({
    db,
    userId: user.id,
    workspaceId: membership.workspaceId,
    installationId: installation.installationId,
    productId,
    area,
    repo: created,
  });
}

/**
 * Connect a repository the installation can already access as the area's doc
 * source. The repo must be in the installation's accessible list (the same
 * check the spec-repo connect route makes), so a guessed owner/name pair
 * never binds someone else's repo.
 */
async function connectExistingRepo(opts: {
  db: NonNullable<ReturnType<typeof getDb>>;
  userId: string;
  workspaceId: string;
  installation: { installationId: string; accountLogin: string };
  productId: string;
  area: ReturnType<typeof parseDocArea>;
  owner: string;
  name: string;
}): Promise<Response> {
  const { db, installation, owner, name } = opts;
  if (!owner || !name) {
    return Response.json({ error: "Pick a repository to connect." }, { status: 400 });
  }

  let match: { owner: string; name: string; defaultBranch: string } | undefined;
  if (isE2E()) {
    const { e2eInstallationRepos } = await import("@/lib/github-e2e");
    match = e2eInstallationRepos(installation.accountLogin).find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
    );
  } else {
    const app = await getGithubApp(db);
    if (!app) {
      return Response.json({ error: "GitHub App is not configured." }, { status: 501 });
    }
    let granted;
    try {
      granted = await listInstallationRepositories(app, installation.installationId);
    } catch (err) {
      console.error("[github] failed to list installation repositories:", err);
      return Response.json(
        { error: "Couldn't list the installation's repositories. Please try again." },
        { status: 502 },
      );
    }
    match = granted.find(
      (r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase(),
    );
  }
  if (!match) {
    return Response.json(
      { error: "The GitHub App installation cannot access that repository." },
      { status: 403 },
    );
  }

  return bindDocRepo({
    db,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    installationId: installation.installationId,
    productId: opts.productId,
    area: opts.area,
    repo: {
      owner: match.owner,
      name: match.name,
      defaultBranch: match.defaultBranch,
      htmlUrl: `https://github.com/${match.owner}/${match.name}`,
    },
  });
}

/**
 * Register the repo row and bind it as the area's doc source. New rows get
 * `isSpecRepo: false` + no config so spec sync ignores them; the conflict
 * branch leaves those columns alone, so a repo already connected for specs
 * keeps working as one.
 */
async function bindDocRepo(opts: {
  db: NonNullable<ReturnType<typeof getDb>>;
  userId: string;
  workspaceId: string;
  installationId: string;
  productId: string;
  area: ReturnType<typeof parseDocArea>;
  repo: { owner: string; name: string; defaultBranch: string; htmlUrl: string };
}): Promise<Response> {
  const { db, repo: target } = opts;
  const [repo] = await db
    .insert(repositories)
    .values({
      workspaceId: opts.workspaceId,
      githubInstallationId: opts.installationId,
      owner: target.owner,
      name: target.name,
      defaultBranch: target.defaultBranch,
      isSpecRepo: false,
    })
    .onConflictDoUpdate({
      target: [repositories.workspaceId, repositories.owner, repositories.name],
      set: {
        githubInstallationId: opts.installationId,
        defaultBranch: target.defaultBranch,
      },
    })
    .returning();
  if (!repo) {
    return Response.json(
      { error: `Couldn't connect ${target.owner}/${target.name}.` },
      { status: 500 },
    );
  }

  // Bind it as the area's doc source (validates the product too).
  try {
    const store = await getStore();
    const space = await store.setDocSpace(
      opts.productId,
      opts.area,
      { mode: "github", repoId: repo.id },
      { userId: opts.userId, workspaceId: opts.workspaceId },
    );
    return Response.json(
      {
        space,
        repository: {
          id: repo.id,
          owner: target.owner,
          name: target.name,
          defaultBranch: target.defaultBranch,
          htmlUrl: target.htmlUrl,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
