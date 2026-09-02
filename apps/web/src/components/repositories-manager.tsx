"use client";

import { useCallback, useMemo, useState } from "react";

import {
  type CreatedSpecRepo,
  type InstallationConnectState,
  type RepoProductLinksPayload,
} from "@/lib/api-client/repositories";
import {
  type ConnectedRepo,
  type RepoProductOption,
  type SetupNotice,
  orgInstallationOf,
} from "@/components/repositories-manager/shared";
import { RepoList } from "@/components/repositories-manager/repo-settings";
import {
  HostedNotConfiguredCard,
  SetupGitHubCard,
} from "@/components/repositories-manager/github-app-setup";
import { SpecImportPanel } from "@/components/repositories-manager/spec-import";
import { ConnectSection } from "@/components/repositories-manager/connect";

interface RepositoriesManagerProps {
  repos: ConnectedRepo[];
  /** Whether the viewer (admin) may set up / connect / re-sync repositories. */
  canConnect: boolean;
  /** Whether the deployment has a GitHub App configured yet. */
  configured: boolean;
  /** Self-host (single-tenant) deployment: admins create their own GitHub App.
   *  On hosted (multi-tenant), the App is shared and managed by Specboards. */
  selfHosted: boolean;
  /** This deployment's own origin, shown in the manual GitHub App instructions. */
  appOrigin: string;
  /** Whether GitHub could reach this origin. False rules the one-click manifest
   *  flow out entirely: GitHub refuses to create an App whose webhook URL it
   *  cannot deliver to, so the manual path is the only one that can work. */
  originIsPublic: boolean;
  /** GitHub App "install" URL once the App exists, else null. */
  installUrl: string | null;
  /** One-time banner from the setup/callback round-trip. */
  notice: SetupNotice;
  /** Server-prefetched connect-picker state, so it renders without a pop-in. */
  installations: InstallationConnectState;
  /** The workspace's products (viewer-readable), for the repo link editor. */
  products?: RepoProductOption[];
  /** Each repo's product links, keyed by repo id (absent repo = link-less). */
  links?: Record<string, RepoProductLinksPayload>;
  /** The workspace's leaf level key, so post-import links land on the level
   * imported specs actually occupy rather than the board's default. */
  leafLevelKey?: string;
}

export function RepositoriesManager({
  repos,
  canConnect,
  configured,
  selfHosted,
  appOrigin,
  originIsPublic,
  installUrl,
  notice,
  installations,
  products = [],
  links = {},
  leafLevelKey,
}: RepositoriesManagerProps) {
  // Bumped after a repo is connected so the import panel re-scans for new specs.
  const [scanNonce, setScanNonce] = useState(0);
  const bumpScan = useCallback(() => setScanNonce((n) => n + 1), []);

  // Repos created in this session, held until the server render catches up.
  //
  // `repos` is a server prop, and `router.refresh()` is not awaitable, so the
  // "Created and connected owner/name" message could paint while the list above
  // still said "No repositories connected". Two statements on one screen
  // contradicting each other, one of them wrong, at the exact moment an
  // evaluator is deciding whether the product works.
  //
  // Holding the new repo locally makes the list correct immediately rather than
  // eventually. The merge is keyed by id, so when the refresh does land and the
  // server includes it, nothing doubles up.
  const [justCreated, setJustCreated] = useState<ConnectedRepo[]>([]);
  const onRepoCreated = useCallback((repo?: CreatedSpecRepo) => {
    if (repo) {
      setJustCreated((prev) =>
        prev.some((r) => r.id === repo.id)
          ? prev
          : [
              ...prev,
              {
                id: repo.id,
                owner: repo.owner,
                name: repo.name,
                defaultBranch: repo.defaultBranch,
                // The create endpoint connects through the workspace's own
                // organization installation, which is the only one it can use.
                githubInstallationId: "",
                isSpecRepo: true,
              },
            ],
      );
    }
    setScanNonce((n) => n + 1);
  }, []);

  const allRepos = useMemo(() => {
    if (justCreated.length === 0) return repos;
    const seen = new Set(repos.map((r) => r.id));
    return [...repos, ...justCreated.filter((r) => !seen.has(r.id))];
  }, [repos, justCreated]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          Specboards imports <code>specs/**/spec.md</code> from connected
          repositories and keeps the board in sync on every push.
        </p>
      </div>

      {notice ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "ok"
              ? "border-input text-muted-foreground"
              : "border-destructive/40 text-destructive"
          }`}
        >
          {notice.message}
        </p>
      ) : null}

      <RepoList
        repos={allRepos}
        canResync={canConnect && configured}
        canManage={canConnect}
        products={products}
        links={links}
      />

      {canConnect && configured && allRepos.length > 0 ? (
        <SpecImportPanel
          leafLevelKey={leafLevelKey}
          scanNonce={scanNonce}
          repos={allRepos}
          installUrl={installUrl}
          orgInstallationId={orgInstallationOf(installations.installations)}
          onRepoCreated={onRepoCreated}
        />
      ) : null}

      {!canConnect ? (
        <p className="text-sm text-muted-foreground">
          {configured
            ? "Only the owner can connect repositories."
            : "GitHub isn't set up yet. Ask an admin to connect Specboards to GitHub."}
        </p>
      ) : configured ? (
        <ConnectSection
          installUrl={installUrl}
          connected={allRepos}
          onConnected={bumpScan}
          initial={installations}
        />
      ) : selfHosted ? (
        <SetupGitHubCard origin={appOrigin} originIsPublic={originIsPublic} />
      ) : (
        <HostedNotConfiguredCard />
      )}
    </div>
  );
}
