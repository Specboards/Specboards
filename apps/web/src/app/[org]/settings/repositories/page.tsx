import { eq, repositories } from "@specboard/db";

import { getDb } from "@/lib/db";
import { getGithubAppSlug, isGithubConfigured } from "@/lib/github-app";
import { loadWorkspaceInstallations, NO_INSTALLATIONS } from "@/lib/github-connect";
import { isSingleTenant } from "@/lib/tenancy";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { RepositoriesManager, type SetupNotice } from "@/components/repositories-manager";

export const dynamic = "force-dynamic";

/** Map the callback/setup query params to a user-facing banner. */
function noticeFor(params: Record<string, string | string[] | undefined>): SetupNotice {
  if (params.setup === "done") {
    return { kind: "ok", message: "GitHub app created. Now install it on your repositories below." };
  }
  if (params.connected === "1") {
    return { kind: "ok", message: "GitHub installed. Pick the repositories to connect below." };
  }
  const errors: Record<string, string> = {
    forbidden: "Only the owner can set up GitHub.",
    org: "That doesn't look like a valid GitHub organization name.",
    setup: "That setup session expired. Please start again.",
    exchange: "GitHub couldn't finish creating the app. Please try again.",
    store: "Couldn't save the GitHub credentials. Please try again.",
    install: "The installation didn't complete. Please try again.",
    hosted: "GitHub is managed by Specboard on the hosted plan. Just install the app below.",
  };
  const err = typeof params.error === "string" ? errors[params.error] : undefined;
  return err ? { kind: "error", message: err } : null;
}

/**
 * Connected repositories. Any member sees the list; only admins get the GitHub
 * setup/connect controls (matching the API authorization).
 */
export default async function RepositoriesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const db = getDb();

  if (!access || !db) {
    return (
      <p className="text-sm text-muted-foreground">
        Repository management is unavailable in local file mode.
      </p>
    );
  }

  const rows = await db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      githubInstallationId: repositories.githubInstallationId,
      isSpecRepo: repositories.isSpecRepo,
    })
    .from(repositories)
    .where(eq(repositories.workspaceId, access.workspaceId));

  const [configured, slug] = await Promise.all([
    isGithubConfigured(db),
    getGithubAppSlug(db),
  ]);

  // Prefetch the connect picker's repo list so it renders with the initial
  // HTML instead of popping in after a client fetch. Costs one GitHub call per
  // workspace installation; a workspace with none skips GitHub entirely.
  const installations =
    access.role === "owner" && configured
      ? await loadWorkspaceInstallations(db, access.workspaceId)
      : NO_INSTALLATIONS;

  return (
    <RepositoriesManager
      repos={rows}
      canConnect={access.role === "owner"}
      configured={configured}
      selfHosted={isSingleTenant()}
      installUrl={slug ? "/api/v1/github/install-start" : null}
      notice={noticeFor(await searchParams)}
      installations={installations}
    />
  );
}
