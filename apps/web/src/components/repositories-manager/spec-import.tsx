"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  type CreatedSpecRepo,
  createStarterSpec,
  type ImportResult,
  importWorkspaceSpecs,
  type RepoScan,
  scanWorkspaceSpecs,
  type StarterSpecResult,
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
import { useOrgProductPath } from "@/lib/use-org";
import type { ConnectedRepo } from "@/components/repositories-manager/shared";
import { CreateSpecRepoNudge } from "@/components/repositories-manager/create-spec-repo";

/**
 * Onboarding: finding the specs in a connected repository and importing them.
 *
 * The panel scans, reports what it found, and imports. What makes it more than
 * a button is the empty case: a repository with no specs is the likeliest
 * outcome for someone evaluating Specboards, and the panel has to turn that
 * into a next step rather than a dead end.
 */

/**
 * Onboarding "import your specs" step. After repos are connected (but not yet
 * imported), this scans them read-only and asks the admin to confirm before
 * creating cards. The smallest end-to-end slice of the spec-onboarding flow:
 * scan -> prompt -> create -> view board. The empty state is the hook for the
 * "no specs yet, let's build your first one" walkthrough (a later slice).
 */
export function SpecImportPanel({
  scanNonce,
  repos,
  installUrl,
  orgInstallationId,
  onRepoCreated,
  leafLevelKey,
}: {
  scanNonce: number;
  repos: ConnectedRepo[];
  installUrl: string | null;
  /** Organization installation id, enabling one-click spec-repo creation. */
  orgInstallationId: string | null;
  /** Called when the nudge creates a repo, so the panel re-scans and the
   *  connected list can show it without waiting on a server refresh. */
  onRepoCreated: (repo?: CreatedSpecRepo) => void;
  /** The workspace's leaf level key; see RepositoriesManagerProps. */
  leafLevelKey?: string;
}) {
  const router = useRouter();
  const boardPath = useOrgProductPath();
  // Imported specs are leaf work items, and sync no longer invents a Feature
  // grouping to home them under (ADR 0003 D3), so the board's default level
  // would be empty right after an import. Send people to the level their
  // specs actually occupy.
  const importedBoardHref = leafLevelKey
    ? boardPath(`/backlog?level=${encodeURIComponent(leafLevelKey)}`)
    : boardPath("/backlog");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<{
    repos: RepoScan[];
    totalSpecs: number;
  } | null>(null);
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
          We scan your connected repositories for <code>spec.md</code> files and
          turn each one into a work item on your board. Nothing is created until
          you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !scan ? (
          <div className="space-y-2" aria-busy="true">
            <p className="text-xs text-muted-foreground">
              Scanning your repositories for specs…
            </p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-xs text-destructive">{error}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void rescan()}
              disabled={loading}
            >
              {loading ? "…" : "Try again"}
            </Button>
          </div>
        ) : result ? (
          <ImportResultView
            result={result}
            boardHref={importedBoardHref}
            onRescan={() => void rescan()}
          />
        ) : totalSpecs === 0 ? (
          <EmptySpecsState
            repos={repos}
            boardHref={importedBoardHref}
            onRescan={() => void rescan()}
            loading={loading}
            installUrl={installUrl}
            orgInstallationId={orgInstallationId}
            onRepoCreated={onRepoCreated}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              We found <strong>{totalSpecs}</strong> spec
              {totalSpecs === 1 ? "" : "s"} across your connected repositories.
            </p>
            <SpecScanList repos={scan!.repos} />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runImport} disabled={importing}>
                {importing
                  ? "Creating…"
                  : `Create ${totalSpecs} card${totalSpecs === 1 ? "" : "s"}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void rescan()}
                disabled={importing || loading}
              >
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
                <li
                  key={spec.path}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm">{spec.title}</span>
                  <code className="shrink-0 text-2xs text-muted-foreground">
                    {spec.path}
                  </code>
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
  const unparented = summary.unparented;
  const imported = summary.upserted;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Imported <strong>{imported}</strong> spec{imported === 1 ? "" : "s"}
        {unparented > 0 ? (
          <>
            {" "}
            (<strong>{unparented}</strong> not yet under a feature, waiting in
            Unassigned)
          </>
        ) : null}
        .
      </p>
      {result.errors.length > 0 ? (
        <div className="space-y-1">
          {result.errors.map((e) => (
            <p
              key={`${e.owner}/${e.name}`}
              className="text-xs text-destructive"
            >
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
  onRepoCreated: (repo?: CreatedSpecRepo) => void;
}) {
  const router = useRouter();
  const [featureName, setFeatureName] = useState("");
  // Target the dedicated spec repo when there is one; otherwise the first
  // connected repo. A manual pick always wins.
  const specRepo = repos.find((r) => r.isSpecRepo) ?? null;
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  const repoId = pickedRepoId ?? specRepo?.id ?? repos[0]?.id ?? "";
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<StarterSpecResult | null>(null);
  const targetRepo = repos.find((r) => r.id === repoId) ?? null;

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
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't create the starter spec.",
        );
      }
    });
  }

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Committed <code>{created.path}</code>
          {targetRepo ? (
            <>
              {" "}
              to{" "}
              <span className="font-medium">
                {targetRepo.owner}/{targetRepo.name}
              </span>
            </>
          ) : null}{" "}
          and added it to your board. Edit the file in your repo anytime, the
          card stays in sync.
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
      <p className="text-sm">
        We didn&apos;t find any specs in your connected repositories yet.
      </p>
      <p className="text-xs text-muted-foreground">
        Let&apos;s create your first one. We&apos;ll commit a starter{" "}
        <code>specs/&lt;feature&gt;/spec.md</code> to your repo and turn it into
        a card, so you can see how specs and the board stay in sync.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Feature name
          </span>
          <Input
            value={featureName}
            onChange={(e) => setFeatureName(e.target.value)}
            placeholder="Checkout flow"
            disabled={pending}
          />
        </label>
        {repos.length > 1 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Repository
            </span>
            <select
              value={repoId}
              onChange={(e) => setPickedRepoId(e.target.value)}
              disabled={pending}
              className="h-8 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {[...repos]
                .sort(
                  (a, b) =>
                    Number(b.isSpecRepo ?? false) -
                    Number(a.isSpecRepo ?? false),
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.owner}/{r.name}
                    {r.isSpecRepo ? " (spec repo)" : ""}
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
      {/* Once a dedicated spec repo exists, the "prefer a dedicated repo?"
          instructions have served their purpose. */}
      {specRepo ? null : (
        <CreateSpecRepoNudge
          installUrl={installUrl}
          orgInstallationId={orgInstallationId}
          onCreated={onRepoCreated}
        />
      )}
    </div>
  );
}
