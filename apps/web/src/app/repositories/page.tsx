import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { githubAppInstallUrl } from "@/lib/github-install";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { RepositoriesManager } from "@/components/repositories-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repositories · SpecBoard" };

/**
 * Connected repositories. Any member sees the list; only admins get the
 * connect/re-sync controls (matching the /api/v1/repositories authorization).
 */
export default async function RepositoriesPage() {
  const access = await requireWorkspaceAccess();
  const db = getDb();

  if (!access || !db) {
    return (
      <section className="mx-auto mt-16 max-w-xl text-center">
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Repository management is unavailable in local file mode.
        </p>
      </section>
    );
  }

  const rows = await db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      githubInstallationId: repositories.githubInstallationId,
    })
    .from(repositories)
    .where(eq(repositories.workspaceId, access.workspaceId));

  return (
    <RepositoriesManager
      repos={rows}
      canConnect={access.role === "admin"}
      installUrl={githubAppInstallUrl()}
    />
  );
}
