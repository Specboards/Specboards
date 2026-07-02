"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  connectRepository,
  createSpecRepository,
  createStarterSpec,
  disconnectRepository,
  importWorkspaceSpecs,
  listInstallationRepositories,
  scanWorkspaceSpecs,
  type CreatedSpecRepo,
  type ImportResult,
  type InstallationConnectState,
  type InstallationRepo,
  type RepoScan,
  type StarterSpecResult,
  type SyncResult,
  type WorkspaceInstallation,
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
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgProductPath } from "@/lib/use-org";

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
  /** Self-host (single-tenant) deployment: admins create their own GitHub App.
   *  On hosted (multi-tenant), the App is shared and managed by Specboard. */
  selfHosted: boolean;
  /** GitHub App "install" URL once the App exists, else null. */
  installUrl: string | null;
  /** One-time banner from the setup/callback round-trip. */
  notice: SetupNotice;
  /** Server-prefetched connect-picker state, so it renders without a pop-in. */
  installations: InstallationConnectState;
}

/** The workspace's organization installation to target for repo creation. */
function orgInstallationOf(installations: WorkspaceInstallation[]): string | null {
  return installations.find((i) => i.accountType === "Organization")?.installationId ?? null;
}

type Status = { kind: "ok" | "error"; message: string } | null;

function syncMessage(sync: SyncResult | { error: string }): { kind: "ok" | "error"; message: string } {
  if ("error" in sync) return { kind: "error", message: sync.error };
  const parts = [`${sync.upserted} imported`, `${sync.skipped} unchanged`];
  if (sync.idsInjected > 0) parts.push(`${sync.idsInjected} stable id(s) assigned`);
  if (sync.featuresCreated > 0) parts.push(`${sync.featuresCreated} feature(s) created`);
  return { kind: "ok", message: parts.join(" · ") };
}

export function RepositoriesManager({
  repos,
  canConnect,
  configured,
  selfHosted,
  installUrl,
  notice,
  installations,
}: RepositoriesManagerProps) {
  // Bumped after a repo is connected so the import panel re-scans for new specs.
  const [scanNonce, setScanNonce] = useState(0);
  const bumpScan = useCallback(() => setScanNonce((n) => n + 1), []);

  return (
    <div className="mx-auto w-full max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          Specboard imports <code>specs/**/spec.md</code> from connected repositories and keeps the
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

      <RepoList repos={repos} canResync={canConnect && configured} canManage={canConnect} />

      {canConnect && configured && repos.length > 0 ? (
        <SpecImportPanel
          scanNonce={scanNonce}
          repos={repos}
          installUrl={installUrl}
          orgInstallationId={orgInstallationOf(installations.installations)}
          onRepoCreated={bumpScan}
        />
      ) : null}

      {!canConnect ? (
        <p className="text-sm text-muted-foreground">
          {configured
            ? "Only an admin can connect repositories."
            : "GitHub isn't set up yet. Ask an admin to connect Specboard to GitHub."}
        </p>
      ) : configured ? (
        <ConnectSection
          installUrl={installUrl}
          connected={repos}
          onConnected={bumpScan}
          initial={installations}
        />
      ) : selfHosted ? (
        <SetupGitHubCard />
      ) : (
        <HostedNotConfiguredCard />
      )}
    </div>
  );
}

/**
 * Onboarding "import your specs" step. After repos are connected (but not yet
 * imported), this scans them read-only and asks the admin to confirm before
 * creating cards. The smallest end-to-end slice of the spec-onboarding flow:
 * scan -> prompt -> create -> view board. The empty state is the hook for the
 * "no specs yet, let's build your first one" walkthrough (a later slice).
 */
function SpecImportPanel({
  scanNonce,
  repos,
  installUrl,
  orgInstallationId,
  onRepoCreated,
}: {
  scanNonce: number;
  repos: ConnectedRepo[];
  installUrl: string | null;
  /** Organization installation id, enabling one-click spec-repo creation. */
  orgInstallationId: string | null;
  /** Called when the nudge creates a repo, so the panel re-scans. */
  onRepoCreated: () => void;
}) {
  const router = useRouter();
  const boardPath = useOrgProductPath();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<{ repos: RepoScan[]; totalSpecs: number } | null>(null);
  const [importing, startImport] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);

  const rescan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setScan(await scanWorkspaceSpecs());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't scan for specs.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-scan on mount and whenever a new repo is connected (scanNonce bump),
  // clearing any prior import result so the prompt reflects the current repos.
  useEffect(() => {
    setResult(null);
    void rescan();
  }, [rescan, scanNonce]);

  function runImport() {
    startImport(async () => {
      setError(null);
      try {
        const res = await importWorkspaceSpecs();
        setResult(res);
        router.refresh();
        await rescan();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed.");
      }
    });
  }

  const totalSpecs = scan?.totalSpecs ?? 0;
  const scanErrors = (scan?.repos ?? []).filter((r) => r.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import your specs</CardTitle>
        <CardDescription>
          We scan your connected repositories for <code>spec.md</code> files and turn each one into a
          work item on your board. Nothing is created until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !scan ? (
          <div className="space-y-2" aria-busy="true">
            <p className="text-xs text-muted-foreground">Scanning your repositories for specs…</p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-xs text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void rescan()} disabled={loading}>
              {loading ? "…" : "Try again"}
            </Button>
          </div>
        ) : result ? (
          <ImportResultView result={result} boardHref={boardPath("/backlog")} onRescan={() => void rescan()} />
        ) : totalSpecs === 0 ? (
          <EmptySpecsState
            repos={repos}
            boardHref={boardPath("/backlog")}
            onRescan={() => void rescan()}
            loading={loading}
            installUrl={installUrl}
            orgInstallationId={orgInstallationId}
            onRepoCreated={onRepoCreated}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              We found <strong>{totalSpecs}</strong> spec{totalSpecs === 1 ? "" : "s"} across your
              connected repositories.
            </p>
            <SpecScanList repos={scan!.repos} />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runImport} disabled={importing}>
                {importing ? "Creating…" : `Create ${totalSpecs} card${totalSpecs === 1 ? "" : "s"}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void rescan()} disabled={importing || loading}>
                Rescan
              </Button>
            </div>
          </div>
        )}

        {scanErrors.length > 0 ? (
          <div className="space-y-1 border-t pt-3">
            {scanErrors.map((r) => (
              <p key={r.repoId} className="text-xs text-destructive">
                {r.owner}/{r.name}: {r.error}
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The list of specs found by the scan, grouped by repo and capped for length. */
function SpecScanList({ repos }: { repos: RepoScan[] }) {
  const withSpecs = repos.filter((r) => r.specs.length > 0);
  const CAP = 8;
  return (
    <div className="space-y-3">
      {withSpecs.map((repo) => {
        const shown = repo.specs.slice(0, CAP);
        const extra = repo.specs.length - shown.length;
        return (
          <div key={repo.repoId} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {repo.owner}/{repo.name}
            </p>
            <ul className="divide-y rounded-md border">
              {shown.map((spec) => (
                <li key={spec.path} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm">{spec.title}</span>
                  <code className="shrink-0 text-[11px] text-muted-foreground">{spec.path}</code>
                </li>
              ))}
            </ul>
            {extra > 0 ? (
              <p className="text-xs text-muted-foreground">+{extra} more</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Shown after a successful import: the summary plus a link to the board. */
function ImportResultView({
  result,
  boardHref,
  onRescan,
}: {
  result: ImportResult;
  boardHref: string;
  onRescan: () => void;
}) {
  const { summary } = result;
  const created = summary.featuresCreated;
  const imported = summary.upserted;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Imported <strong>{imported}</strong> spec{imported === 1 ? "" : "s"}
        {created > 0 ? (
          <>
            {" "}
            and created <strong>{created}</strong> feature group{created === 1 ? "" : "s"}
          </>
        ) : null}
        .
      </p>
      {result.errors.length > 0 ? (
        <div className="space-y-1">
          {result.errors.map((e) => (
            <p key={`${e.owner}/${e.name}`} className="text-xs text-destructive">
              {e.owner}/{e.name}: {e.error}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Link href={boardHref}>
          <Button size="sm">View your board</Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={onRescan}>
          Scan again
        </Button>
      </div>
    </div>
  );
}

/**
 * No specs found in the connected repos: the guided "build your first spec"
 * walkthrough. Commits a starter `specs/<feature>/spec.md` into a connected repo
 * and imports it, so a new admin gets a real card and feels the whole loop. On
 * success it shows what was committed plus a link to the board.
 */
function EmptySpecsState({
  repos,
  boardHref,
  onRescan,
  loading,
  installUrl,
  orgInstallationId,
  onRepoCreated,
}: {
  repos: ConnectedRepo[];
  boardHref: string;
  onRescan: () => void;
  loading: boolean;
  installUrl: string | null;
  orgInstallationId: string | null;
  onRepoCreated: () => void;
}) {
  const router = useRouter();
  const [featureName, setFeatureName] = useState("");
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<StarterSpecResult | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = featureName.trim();
    if (!name) {
      setError("Give your first feature a name.");
      return;
    }
    if (!repoId) {
      setError("Pick a repository to add it to.");
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        const result = await createStarterSpec({ repoId, featureName: name });
        setCreated(result);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create the starter spec.");
      }
    });
  }

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Committed <code>{created.path}</code> and added it to your board. Edit the file in your
          repo anytime, the card stays in sync.
        </p>
        <div className="flex items-center gap-2">
          <Link href={boardHref}>
            <Button size="sm">View your board</Button>
          </Link>
          <Button size="sm" variant="ghost" onClick={onRescan}>
            Scan again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">We didn&apos;t find any specs in your connected repositories yet.</p>
      <p className="text-xs text-muted-foreground">
        Let&apos;s create your first one. We&apos;ll commit a starter{" "}
        <code>specs/&lt;feature&gt;/spec.md</code> to your repo and turn it into a card, so you can
        see how specs and the board stay in sync.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Feature name</span>
          <Input
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            placeholder="Checkout flow"
            disabled={pending}
          />
        </label>
        {repos.length > 1 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Repository</span>
            <select
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
              disabled={pending}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create my first spec"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onRescan}
            disabled={pending || loading}
          >
            {loading ? "…" : "Rescan"}
          </Button>
        </div>
      </form>
      <CreateSpecRepoNudge
        installUrl={installUrl}
        orgInstallationId={orgInstallationId}
        onCreated={onRepoCreated}
      />
    </div>
  );
}

/**
 * Nudge for users who'd rather keep specs in their own repository. With a
 * pending organization installation we can create and connect the repo in one
 * click (the App's repository Administration permission); otherwise, or when
 * that fails, the manual steps remain: deep-link to GitHub's new-repo page,
 * install the App on it, connect it here. Shown in the two "no suitable repo"
 * moments: the connect section (nothing connected) and the empty-specs
 * first-spec state.
 */
function CreateSpecRepoNudge({
  installUrl,
  orgInstallationId,
  onCreated,
}: {
  installUrl: string | null;
  /** Organization installation to create in; null hides the one-click form. */
  orgInstallationId: string | null;
  /** Called after a repo is created + connected, so parent panels refresh. */
  onCreated: () => void;
}) {
  const newRepoUrl =
    "https://github.com/new?name=specs&description=" +
    encodeURIComponent("Product specs synced to Specboard");
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Prefer a dedicated repo just for specs?
      </summary>
      <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        <p>Keep your specs in their own repository, separate from application code.</p>
        {orgInstallationId ? (
          <CreateSpecRepoForm installationId={orgInstallationId} onCreated={onCreated} />
        ) : null}
        {orgInstallationId ? <p className="font-medium">Or do it yourself:</p> : null}
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            <a href={newRepoUrl} target="_blank" rel="noreferrer" className="underline">
              Create a repo on GitHub
            </a>{" "}
            (we suggest naming it <code>specs</code>).
          </li>
          <li>
            {installUrl ? (
              <a href={installUrl} target="_blank" rel="noreferrer" className="underline">
                Install Specboard
              </a>
            ) : (
              "Install the Specboard GitHub App"
            )}{" "}
            on the new repo.
          </li>
          <li>Connect it here, then create your first spec.</li>
        </ol>
      </div>
    </details>
  );
}

/**
 * One-click path of the spec-repo nudge: name the repo and Specboard creates a
 * private repo in the installation's GitHub organization, connects it, and
 * hands off to the "create your first spec" walkthrough to seed it. Failures
 * (personal-account installation, missing Administration permission) surface
 * inline and the manual steps below stay available.
 */
function CreateSpecRepoForm({
  installationId,
  onCreated,
}: {
  installationId: string;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("specs");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSpecRepo | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const repoName = name.trim();
    if (!repoName) {
      setError("Give the repository a name.");
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        const result = await createSpecRepository({ name: repoName, installationId });
        setCreated(result);
        router.refresh();
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create the repository.");
      }
    });
  }

  if (created) {
    return (
      <p>
        Created and connected{" "}
        <a href={created.htmlUrl} target="_blank" rel="noreferrer" className="underline">
          {created.owner}/{created.name}
        </a>
        . Now create your first spec in it below.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <p>We can create a private repo in your GitHub organization and connect it for you.</p>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="specs"
          disabled={pending}
          aria-label="Repository name"
          className="h-8"
        />
        <Button type="submit" size="sm" disabled={pending} className="shrink-0">
          {pending ? "Creating…" : "Create and connect"}
        </Button>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
    </form>
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
        <CardTitle>Connect Specboard to GitHub</CardTitle>
        <CardDescription>
          We&apos;ll create a GitHub App on your account or organization in one click, and you
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

/**
 * Hosted (multi-tenant) deployment with no GitHub App credentials configured.
 * Tenants don't create their own App here — it's a shared App Specboard owns —
 * so the right action is to reach support, not run the manifest flow.
 */
function HostedNotConfiguredCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub isn&apos;t available yet</CardTitle>
        <CardDescription>
          GitHub is managed by Specboard on the hosted plan. If you don&apos;t see the option to
          install it, please contact support and we&apos;ll get you connected.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function RepoList({
  repos,
  canResync,
  canManage,
}: {
  repos: ConnectedRepo[];
  canResync: boolean;
  canManage: boolean;
}) {
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
        <RepoRow key={repo.id} repo={repo} canResync={canResync} canManage={canManage} />
      ))}
    </div>
  );
}

function RepoRow({
  repo,
  canResync,
  canManage,
}: {
  repo: ConnectedRepo;
  canResync: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);
  const [confirming, setConfirming] = useState(false);

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
        setStatus(sync ? syncMessage(sync) : { kind: "ok", message: "Re-synced." });
        router.refresh();
      } catch (err) {
        setStatus({ kind: "error", message: err instanceof Error ? err.message : "Re-sync failed." });
      }
    });
  }

  function disconnect() {
    startTransition(async () => {
      setStatus(null);
      try {
        await disconnectRepository(repo.id);
        router.refresh();
      } catch (err) {
        setConfirming(false);
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Disconnect failed.",
        });
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
        <div className="flex shrink-0 items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">
                Stop syncing? Imported items stay on the board.
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirming(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={disconnect} disabled={pending}>
                {pending ? "…" : "Disconnect"}
              </Button>
            </>
          ) : (
            <>
              {canResync ? (
                <Button size="sm" variant="outline" onClick={resync} disabled={pending}>
                  {pending ? "…" : "Re-sync"}
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(true)}
                  disabled={pending}
                >
                  Disconnect
                </Button>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
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
  const [available, setAvailable] = useState<InstallationRepo[]>(initial.repositories);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const state = await listInstallationRepositories();
      setInstallations(state.installations);
      setAvailable(state.repositories);
      setLoadError(state.error);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load repositories.");
    } finally {
      setLoading(false);
    }
  }, []);

  const hasInstallation = installations.length > 0;
  const connectedKeys = new Set(connected.map((r) => `${r.owner}/${r.name}`.toLowerCase()));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a repository</CardTitle>
        <CardDescription>
          Install the Specboard GitHub App on the repositories you want to sync, then connect them
          here. No copying ids by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installUrl ? (
          <a href={installUrl} className="inline-flex">
            <Button type="button">
              {hasInstallation ? "Add or manage repositories on GitHub" : "Connect GitHub"}
            </Button>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set <code>NEXT_PUBLIC_GITHUB_APP_SLUG</code> to enable the one-click GitHub install, or
            use manual entry below.
          </p>
        )}

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : (
          <>
            {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}
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
        const msg = sync ? syncMessage(sync) : { kind: "ok" as const, message: "Connected." };
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
            <Input name="owner" placeholder="Specboards" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Repository</span>
            <Input name="name" placeholder="Specboard" required />
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
