import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { getGithubAppSlug, isGithubConfigured } from "@/lib/github-app";
import { installUrlFromSlug } from "@/lib/github-install";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { RepositoriesManager, type SetupNotice } from "@/components/repositories-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repositories · SpecBoard" };

/** Map the callback/setup query params to a user-facing banner. */
function noticeFor(params: Record<string, string | string[] | undefined>): SetupNotice {
  if (params.setup === "done") {
    return { kind: "ok", message: "GitHub app created. Now install it on your repositories below." };
  }
  if (params.connected === "1") {
    return { kind: "ok", message: "GitHub installed. Pick the repositories to connect below." };
  }
  const errors: Record<string, string> = {
    forbidden: "Only an admin can set up GitHub.",
    org: "That doesn't look like a valid GitHub organization name.",
    setup: "That setup session expired. Please start again.",
    exchange: "GitHub couldn't finish creating the app. Please try again.",
    store: "Couldn't save the GitHub credentials. Please try again.",
    install: "The installation didn't complete. Please try again.",
  };
  const err = typeof params.error === "string" ? errors[params.error] : undefined;
  return err ? { kind: "error", message: err } : null;
}

/**
 * Connected repositories. Any member sees the list; only admins get the GitHub
 * setup/connect controls (matching the API authorization).
 */
export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const [configured, slug] = await Promise.all([
    isGithubConfigured(db),
    getGithubAppSlug(db),
  ]);

  return (
    <RepositoriesManager
      repos={rows}
      canConnect={access.role === "admin"}
      configured={configured}
      installUrl={installUrlFromSlug(slug)}
      notice={noticeFor(await searchParams)}
    />
  );
}
