"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import {
  connectRepository,
  listInstallationRepositories,
  type CreatedSpecRepo,
  type InstallationConnectState,
  type InstallationRepo,
  type RepoProductLinksPayload,
  type WorkspaceInstallation,
} from "@/lib/api-client/repositories";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ConnectedRepo,
  type RepoProductOption,
  type SetupNotice,
  type Status,
  orgInstallationOf,
  syncMessage,
} from "@/components/repositories-manager/shared";
import { RepoList } from "@/components/repositories-manager/repo-settings";
import {
  HostedNotConfiguredCard,
  SetupGitHubCard,
} from "@/components/repositories-manager/github-app-setup";
import { CreateSpecRepoNudge } from "@/components/repositories-manager/create-spec-repo";
import { SpecImportPanel } from "@/components/repositories-manager/spec-import";

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

/**
 * Admin connect controls: the GitHub-App picker (post-install) plus an advanced
 * manual entry fallback. After installing the App, GitHub redirects back and
 * the picker lists the granted repos to connect with one click. The initial
 * picker state is prefetched server-side (no pop-in); `load()` refreshes it
 * client-side after a repo is connected or created.
 */
function ConnectSection({
  installUrl,
  connected,
  onConnected,
  initial,
}: {
  installUrl: string | null;
  connected: ConnectedRepo[];
  /** Called after a repo is connected, so the import panel re-scans. */
  onConnected: () => void;
  /** Server-prefetched picker state, rendered with the initial HTML. */
  initial: InstallationConnectState;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initial.error);
  const [installations, setInstallations] = useState<WorkspaceInstallation[]>(
    initial.installations,
  );
  const [available, setAvailable] = useState<InstallationRepo[]>(
    initial.repositories,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const state = await listInstallationRepositories();
      setInstallations(state.installations);
      setAvailable(state.repositories);
      setLoadError(state.error);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load repositories.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const hasInstallation = installations.length > 0;
  const connectedKeys = new Set(
    connected.map((r) => `${r.owner}/${r.name}`.toLowerCase()),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a repository</CardTitle>
        <CardDescription>
          Install the Specboards GitHub App on the repositories you want to
          sync, then connect them here. No copying ids by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installUrl ? (
          <a href={installUrl} className="inline-flex">
            <Button type="button">
              {hasInstallation
                ? "Add or manage repositories on GitHub"
                : "Connect GitHub"}
            </Button>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code> to enable the one-click
            GitHub install, or use manual entry below.
          </p>
        )}

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : (
          <>
            {loadError ? (
              <p className="text-xs text-destructive">{loadError}</p>
            ) : null}
            {hasInstallation ? (
              <RepoPicker
                repos={available}
                connectedKeys={connectedKeys}
                onConnected={() => {
                  void load();
                  onConnected();
                }}
              />
            ) : null}
          </>
        )}

        <ManualConnectForm />

        {connected.length === 0 ? (
          <CreateSpecRepoNudge
            installUrl={installUrl}
            orgInstallationId={orgInstallationOf(installations)}
            onCreated={() => {
              void load();
              onConnected();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RepoPicker({
  repos,
  connectedKeys,
  onConnected,
}: {
  repos: InstallationRepo[];
  connectedKeys: Set<string>;
  onConnected: () => void;
}) {
  if (repos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The App is installed, but you haven&apos;t granted it access to any
        repositories yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        Available repositories
      </p>
      <div className="divide-y rounded-md border">
        {repos.map((repo) => (
          <PickerRow
            key={`${repo.owner}/${repo.name}`}
            repo={repo}
            alreadyConnected={connectedKeys.has(
              `${repo.owner}/${repo.name}`.toLowerCase(),
            )}
            onConnected={onConnected}
          />
        ))}
      </div>
    </div>
  );
}

function PickerRow({
  repo,
  alreadyConnected,
  onConnected,
}: {
  repo: InstallationRepo;
  alreadyConnected: boolean;
  onConnected: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);

  function connect() {
    startTransition(async () => {
      setStatus(null);
      try {
        // Register the repo but defer importing specs; the "Import your specs"
        // panel scans and asks for confirmation before creating cards.
        await connectRepository({
          installationId: repo.installationId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          sync: false,
        });
        setStatus({ kind: "ok", message: "Connected. Scan for specs below." });
        router.refresh();
        onConnected();
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Connect failed.",
        });
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm">
          {repo.owner}/{repo.name}
          {repo.private ? (
            <span className="ml-2 text-xs text-muted-foreground">private</span>
          ) : null}
        </p>
        {status ? (
          <p
            className={`text-xs ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {status.message}
          </p>
        ) : null}
      </div>
      {alreadyConnected ? (
        <span className="text-xs text-muted-foreground">Connected</span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={connect}
          disabled={pending}
        >
          {pending ? "…" : "Connect"}
        </Button>
      )}
    </div>
  );
}

function ManualConnectForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const installationId = String(data.get("installationId") ?? "").trim();
    const owner = String(data.get("owner") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    const defaultBranch = String(data.get("defaultBranch") ?? "").trim();

    if (!installationId || !owner || !name) {
      setStatus({
        kind: "error",
        message: "Installation ID, owner, and name are required.",
      });
      return;
    }

    startTransition(async () => {
      setStatus(null);
      try {
        const { sync } = await connectRepository({
          installationId,
          owner,
          name,
          defaultBranch: defaultBranch || undefined,
        });
        const msg = sync
          ? syncMessage(sync)
          : { kind: "ok" as const, message: "Connected." };
        setStatus(
          msg.kind === "ok"
            ? { kind: "ok", message: `Connected. ${msg.message}.` }
            : {
                kind: "error",
                message: `Connected, but import failed: ${msg.message}`,
              },
        );
        form.reset();
        router.refresh();
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't connect the repository.",
        });
      }
    });
  }

  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Advanced: connect by installation ID
      </summary>
      <form onSubmit={onSubmit} className="mt-3 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Owner
            </span>
            <Input name="owner" placeholder="Specboards" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Repository
            </span>
            <Input name="name" placeholder="Specboards" required />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Installation ID
            </span>
            <Input name="installationId" placeholder="12345678" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Default branch
            </span>
            <Input name="defaultBranch" placeholder="main" />
          </label>
        </div>
        {status ? (
          <p
            className={`text-xs ${status.kind === "ok" ? "text-muted-foreground" : "text-destructive"}`}
          >
            {status.message}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "…" : "Connect repository"}
        </Button>
      </form>
    </details>
  );
}
