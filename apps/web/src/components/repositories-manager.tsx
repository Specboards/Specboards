"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  connectRepository,
  listInstallationRepositories,
  type InstallationRepo,
  type SyncResult,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ConnectedRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: string;
}

export type SetupNotice = { kind: "ok" | "error"; message: string } | null;

interface RepositoriesManagerProps {
  repos: ConnectedRepo[];
  /** Whether the viewer (admin) may set up / connect / re-sync repositories. */
  canConnect: boolean;
  /** Whether the deployment has a GitHub App configured yet. */
  configured: boolean;
  /** GitHub App "install" URL once the App exists, else null. */
  installUrl: string | null;
  /** One-time banner from the setup/callback round-trip. */
  notice: SetupNotice;
}

type Status = { kind: "ok" | "error"; message: string } | null;

function syncMessage(sync: SyncResult | { error: string }): { kind: "ok" | "error"; message: string } {
  if ("error" in sync) return { kind: "error", message: sync.error };
  const parts = [`${sync.upserted} imported`, `${sync.skipped} unchanged`];
  if (sync.idsInjected > 0) parts.push(`${sync.idsInjected} stable id(s) assigned`);
  return { kind: "ok", message: parts.join(" · ") };
}

export function RepositoriesManager({
  repos,
  canConnect,
  configured,
  installUrl,
  notice,
}: RepositoriesManagerProps) {
  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          SpecBoard imports <code>specs/**/spec.md</code> from connected repositories and keeps the
          board in sync on every push.
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

      <RepoList repos={repos} canResync={canConnect && configured} />

      {!canConnect ? (
        <p className="text-sm text-muted-foreground">
          {configured
            ? "Only an admin can connect repositories."
            : "GitHub isn't set up yet. Ask an admin to connect SpecBoard to GitHub."}
        </p>
      ) : configured ? (
        <ConnectSection installUrl={installUrl} connected={repos} />
      ) : (
        <SetupGitHubCard />
      )}
    </div>
  );
}

/**
 * Shown to an admin before any GitHub App exists. Kicks off the one-click
 * manifest flow: GitHub creates the App, redirects back, and we store the
 * credentials — no copying ids or secrets.
 */
function SetupGitHubCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect SpecBoard to GitHub</CardTitle>
        <CardDescription>
          We&apos;ll create a GitHub App on your account or organization in one click — you just
          confirm on GitHub. After that you can install it on repositories and sync specs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action="/api/v1/github/app/create" method="get" className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              GitHub organization <span className="font-normal">(optional)</span>
            </span>
            <Input name="org" placeholder="your-org" autoCapitalize="none" autoCorrect="off" />
            <span className="block text-xs text-muted-foreground">
              Leave blank to create it on your personal GitHub account.
            </span>
          </label>
          <Button type="submit">Set up GitHub App</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RepoList({ repos, canResync }: { repos: ConnectedRepo[]; canResync: boolean }) {
  if (repos.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No repositories connected yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {repos.map((repo) => (
        <RepoRow key={repo.id} repo={repo} canResync={canResync} />
      ))}
    </div>
  );
}

function RepoRow({ repo, canResync }: { repo: ConnectedRepo; canResync: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);

  function resync() {
    startTransition(async () => {
      setStatus(null);
      try {
        const { sync } = await connectRepository({
          installationId: repo.githubInstallationId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        });
        setStatus(syncMessage(sync));
        router.refresh();
      } catch (err) {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Re-sync failed." });
      }
    });
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {repo.owner}/{repo.name}
          </p>
          <p className="text-xs text-muted-foreground">
            Branch <code>{repo.defaultBranch}</code>
            {status ? (
              <>
                {" · "}
                <span className={status.kind === "error" ? "text-destructive" : ""}>
                  {status.message}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {canResync ? (
          <Button size="sm" variant="outline" onClick={resync} disabled={pending}>
            {pending ? "…" : "Re-sync"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Admin connect controls: the GitHub-App picker (post-install) plus an advanced
 * manual entry fallback. After installing the App, GitHub redirects back and
 * the picker lists the granted repos to connect with one click.
 */
function ConnectSection({
  installUrl,
  connected,
}: {
  installUrl: string | null;
  connected: ConnectedRepo[];
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [available, setAvailable] = useState<InstallationRepo[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { installationId, repositories } = await listInstallationRepositories();
      setInstallationId(installationId);
      setAvailable(repositories);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load repositories.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectedKeys = new Set(connected.map((r) => `${r.owner}/${r.name}`.toLowerCase()));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a repository</CardTitle>
        <CardDescription>
          Install the SpecBoard GitHub App on the repositories you want to sync, then connect them
          here — no copying ids by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installUrl ? (
          <a href={installUrl} className="inline-flex">
            <Button type="button">
              {installationId ? "Add or manage repositories on GitHub" : "Connect GitHub"}
            </Button>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code> to enable the one-click GitHub install, or
            use manual entry below.
          </p>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading available repositories…</p>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : installationId ? (
          <RepoPicker
            installationId={installationId}
            repos={available}
            connectedKeys={connectedKeys}
            onConnected={load}
          />
        ) : null}

        <ManualConnectForm />
      </CardContent>
    </Card>
  );
}

function RepoPicker({
  installationId,
  repos,
  connectedKeys,
  onConnected,
}: {
  installationId: string;
  repos: InstallationRepo[];
  connectedKeys: Set<string>;
  onConnected: () => void;
}) {
  if (repos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        The App is installed, but you haven&apos;t granted it access to any repositories yet.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Available repositories</p>
      <div className="divide-y rounded-md border">
        {repos.map((repo) => (
          <PickerRow
            key={`${repo.owner}/${repo.name}`}
            installationId={installationId}
            repo={repo}
            alreadyConnected={connectedKeys.has(`${repo.owner}/${repo.name}`.toLowerCase())}
            onConnected={onConnected}
          />
        ))}
      </div>
    </div>
  );
}

function PickerRow({
  installationId,
  repo,
  alreadyConnected,
  onConnected,
}: {
  installationId: string;
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
        const { sync } = await connectRepository({
          installationId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        });
        const msg = syncMessage(sync);
        setStatus(
          msg.kind === "ok"
            ? { kind: "ok", message: msg.message }
            : { kind: "error", message: `Connected, but import failed: ${msg.message}` },
        );
        router.refresh();
        onConnected();
      } catch (err) {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Connect failed." });
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
          <p className={`text-xs ${status.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {status.message}
          </p>
        ) : null}
      </div>
      {alreadyConnected ? (
        <span className="text-xs text-muted-foreground">Connected</span>
      ) : (
        <Button size="sm" variant="outline" onClick={connect} disabled={pending}>
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
      setStatus({ kind: "error", message: "Installation ID, owner, and name are required." });
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
        const msg = syncMessage(sync);
        setStatus(
          msg.kind === "ok"
            ? { kind: "ok", message: `Connected. ${msg.message}.` }
            : { kind: "error", message: `Connected, but import failed: ${msg.message}` },
        );
        form.reset();
        router.refresh();
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Couldn't connect the repository.",
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
            <span className="text-xs font-medium text-muted-foreground">Owner</span>
            <Input name="owner" placeholder="StudioPalouse" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Repository</span>
            <Input name="name" placeholder="SpecBoard" required />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Installation ID</span>
            <Input name="installationId" placeholder="12345678" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Default branch</span>
            <Input name="defaultBranch" placeholder="main" />
          </label>
        </div>
        {status ? (
          <p className={`text-xs ${status.kind === "ok" ? "text-muted-foreground" : "text-destructive"}`}>
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
