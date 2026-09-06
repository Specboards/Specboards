"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  connectRepository,
  type CreatedSpecRepo,
  type InstallationConnectState,
  type InstallationRepo,
  listInstallationRepositories,
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
  orgInstallationOf,
  type Status,
  syncMessage,
} from "@/components/repositories-manager/shared";
import { CreateSpecRepoNudge } from "@/components/repositories-manager/create-spec-repo";

/**
 * Connecting a repository that already exists.
 *
 * Two ways in, because the GitHub App may or may not be able to enumerate what
 * the workspace can reach. When it can, the picker lists the installation's
 * repositories and connecting is one click. When it cannot, or the repository
 * is not covered by an installation, the manual form takes an owner and name
 * and connects that.
 *
 * Alongside both, the offer to create a dedicated spec repository instead,
 * which is the right answer when the reader has no repository worth connecting
 * yet.
 */

/**
 * Admin connect controls: the GitHub-App picker (post-install) plus an advanced
 * manual entry fallback. After installing the App, GitHub redirects back and
 * the picker lists the granted repos to connect with one click. The initial
 * picker state is prefetched server-side (no pop-in); `load()` refreshes it
 * client-side after a repo is connected or created.
 */
export function ConnectSection({
  installUrl,
  connected,
  onConnected,
  onRepoCreated,
  initial,
}: {
  installUrl: string | null;
  connected: ConnectedRepo[];
  /** Called after a repo is connected, so the import panel re-scans. */
  onConnected: () => void;
  /**
   * Called with the repo the one-click form just created, so the connected
   * list can show it without waiting for the server render.
   *
   * Separate from `onConnected` because it carries a payload. Connecting an
   * existing repo goes through an endpoint the page will re-read anyway;
   * creating one produces a record only this component has seen, and dropping
   * it here is what left "No repositories connected" on screen next to
   * "Created and connected acme/specs".
   */
  onRepoCreated: (repo?: CreatedSpecRepo) => void;
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

  // Whether the one-click form below created a repo in this session; see the
  // comment where the nudge is rendered.
  const [createdHere, setCreatedHere] = useState(false);

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

        {/* The nudge is for readers with nothing worth connecting, so it goes
            once something is connected -- unless it is the thing that did the
            connecting. Unmounting it the instant it succeeds would take its
            own "Created and connected" confirmation off screen at the moment
            the reader is looking for it. */}
        {connected.length === 0 || createdHere ? (
          <CreateSpecRepoNudge
            installUrl={installUrl}
            orgInstallationId={orgInstallationOf(installations)}
            successHint="Create your first spec in it from the panel above."
            onCreated={(repo) => {
              setCreatedHere(true);
              onRepoCreated(repo);
              void load();
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
