import { eq, githubInstallations, type Database } from "@specboard/db";
import { listInstallationRepositories, type InstallationRepo } from "@specboard/git";

import { isE2E } from "@/lib/e2e";
import { getGithubApp } from "@/lib/github-app";

/** A GitHub App installation bound to the workspace. */
export interface WorkspaceInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** A repo the workspace can connect, tagged with the installation it's from. */
export type ConnectableRepo = InstallationRepo & { installationId: string };

/** The workspace's installations and every repo they can access. */
export interface InstallationConnectState {
  installations: WorkspaceInstallation[];
  repositories: ConnectableRepo[];
  /** Set when some repo lists couldn't be loaded (partial data is possible). */
  error: string | null;
}

/** The empty state: no installations bound to the workspace yet. */
export const NO_INSTALLATIONS: InstallationConnectState = {
  installations: [],
  repositories: [],
  error: null,
};

/** True for a GitHub 404 (Octokit RequestError shape). */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
}

/**
 * The workspace's persisted GitHub App installations and the repositories each
 * can access. Backs the connect picker: the page calls it server-side so the
 * picker renders with the initial HTML, and the API route serves refreshes.
 * An installation GitHub no longer knows (the App was uninstalled and the
 * webhook was missed) is deleted here, so the state self-heals.
 */
export async function loadWorkspaceInstallations(
  db: Database,
  workspaceId: string,
): Promise<InstallationConnectState> {
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId))
    .orderBy(githubInstallations.createdAt);
  if (rows.length === 0) return NO_INSTALLATIONS;

  // E2E runs with a faked GitHub and no App credentials; report the seeded
  // installations with no listable repos rather than an error.
  if (isE2E()) return { installations: rows, repositories: [], error: null };

  const app = await getGithubApp(db);
  if (!app) {
    return { installations: rows, repositories: [], error: "GitHub App is not configured." };
  }

  const installations: WorkspaceInstallation[] = [];
  const repositories: ConnectableRepo[] = [];
  let error: string | null = null;
  for (const row of rows) {
    try {
      const repos = await listInstallationRepositories(app, row.installationId);
      installations.push(row);
      repositories.push(...repos.map((r) => ({ ...r, installationId: row.installationId })));
    } catch (err) {
      if (isNotFound(err)) {
        // GitHub no longer knows this installation: the App was uninstalled.
        console.warn(`[github] pruning stale installation ${row.installationId}`);
        await db
          .delete(githubInstallations)
          .where(eq(githubInstallations.installationId, row.installationId));
        continue;
      }
      console.error(
        `[github] failed to list repositories for installation ${row.installationId}:`,
        err,
      );
      installations.push(row);
      error = "Couldn't load repositories for some installations.";
    }
  }
  return { installations, repositories, error };
}

/**
 * The installation a workspace-owned repo creation should target: verifies the
 * requested installation belongs to the workspace, or picks the workspace's
 * only organization installation when none is specified.
 */
export async function resolveWorkspaceInstallation(
  db: Database,
  workspaceId: string,
  installationId: string | null,
): Promise<WorkspaceInstallation | null> {
  const rows = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId));
  if (installationId) {
    return rows.find((r) => r.installationId === installationId) ?? null;
  }
  const orgs = rows.filter((r) => r.accountType === "Organization");
  return orgs.length === 1 ? orgs[0]! : null;
}
