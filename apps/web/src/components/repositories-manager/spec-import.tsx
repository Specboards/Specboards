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
import { importCounts } from "@/lib/import-summary";
import { useOrgProductPath } from "@/lib/use-org";
import { useResetOnChange } from "@/lib/use-reset-on-change";
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
    newSpecs: number;
  } | null>(null);
  const [importing, startImport] = useTransition();
  const [result, setResult] = useState<ImportResult | null>(null);

  /**
   * The scan itself. Nothing is set before the first await, which is what lets
   * the effect below call it: a synchronous `setLoading(true)` inside an effect
   * is the thing `react-hooks/set-state-in-effect` is pointing at, and moving
   * it to the two callers that are actually events is the fix rather than the
   * workaround.
   */
  const runScan = useCallback(async () => {
    try {
      setScan(await scanWorkspaceSpecs());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't scan for specs.");
    } finally {
      setLoading(false);
    }
  }, []);

  /** Scan on the reader's say-so: shows the spinner, then scans. */
  const rescan = useCallback(async () => {
    setLoading(true);
    setError(null);
    await runScan();
  }, [runScan]);

  /**
   * "Scan again", as offered under an import summary: re-scan *and* leave that
   * summary behind.
   *
   * The plain `rescan` cannot do this, because `runImport` calls it to refresh
   * the scan behind a summary it has just set. Without the split, the summary
   * outlived every rescan and the button read as doing nothing: the panel had
   * quietly learned that everything was imported and had no way to say so.
   */
  const scanAgain = useCallback(async () => {
    setResult(null);
    await rescan();
  }, [rescan]);

  // Clearing the prior import result belongs to the change of repos, not to the
  // scan: it must be gone in the render that starts the new scan, not one
  // render later, or the panel briefly reports the last repo's import as this
  // repo's.
  // The spinner and the cleared error belong here with it, for the same reason:
  // they describe the scan that is about to start, so they belong to the render
  // that starts it.
  useResetOnChange(scanNonce, () => {
    setResult(null);
    setLoading(true);
    setError(null);
  });

  // Re-scan on mount and whenever a new repo is connected (scanNonce bump).
  useEffect(() => {
    // `runScan` awaits before it sets anything (that is why the spinner is set
    // above instead of inside it), so nothing is set during this effect. The
    // rule cannot see past the call, and fetching on mount is what effects are
    // for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runScan();
  }, [runScan, scanNonce]);

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
  // What the create button would actually do. The panel speaks to this rather
  // than to `totalSpecs`, which describes the repository: on a workspace that
  // has already imported, "Create 200 cards" creates none.
  const newSpecs = scan?.newSpecs ?? 0;
  const alreadyImported = totalSpecs - newSpecs;
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
            onRescan={() => void scanAgain()}
          />
        ) : totalSpecs === 0 ? (
          <EmptySpecsState
            repos={repos}
            boardHref={importedBoardHref}
            onRescan={() => void scanAgain()}
            loading={loading}
            installUrl={installUrl}
            orgInstallationId={orgInstallationId}
            onRepoCreated={onRepoCreated}
          />
        ) : newSpecs === 0 ? (
          <AllImportedState
            total={totalSpecs}
            boardHref={importedBoardHref}
            onRescan={() => void scanAgain()}
            loading={loading}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>{newSpecs}</strong> new spec{newSpecs === 1 ? "" : "s"} to
              import
              {alreadyImported > 0 ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({alreadyImported} already on your board)
                </span>
              ) : null}
              .
            </p>
            {/* Only the new ones: this list is a preview of what the button
                below will create, so listing specs it will not create would
                make the two disagree. */}
            <SpecScanList repos={scan!.repos} />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={runImport} disabled={importing}>
                {importing
                  ? "Creating…"
                  : `Create ${newSpecs} card${newSpecs === 1 ? "" : "s"}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void scanAgain()}
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

/**
 * The specs the import would create, grouped by repo and capped for length.
 *
 * Specs already on the board are left out rather than shown greyed: the list
 * sits directly above "Create N cards" and reads as that button's contents, so
 * a row the button will not act on is the same lie the count used to tell.
 */
function SpecScanList({ repos }: { repos: RepoScan[] }) {
  const withSpecs = repos
    .map((r) => ({ ...r, specs: r.specs.filter((s) => !s.alreadyImported) }))
    .filter((r) => r.specs.length > 0);
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

/**
 * Every spec found is already on the board: the panel's job is done.
 *
 * It recedes to a line and two links rather than disappearing, following the
 * same rule as the other organizing features: hidden until there is something
 * to organize, but never unreachable once it holds data. The rescan is the
 * whole reason to keep it -- this is exactly the state an admin lands in after
 * merging a spec PR, and pressing it is how the new spec arrives.
 */
function AllImportedState({
  total,
  boardHref,
  onRescan,
  loading,
}: {
  total: number;
  boardHref: string;
  onRescan: () => void;
  loading: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {total === 1 ? (
          <>The spec in your connected repositories is already on your board.</>
        ) : (
          <>
            All <strong>{total}</strong> specs in your connected repositories
            are already on your board.
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Merged a new spec since? Rescan to pick it up.
      </p>
      <div className="flex items-center gap-2">
        <Link href={boardHref}>
          <Button size="sm" variant="outline">
            View your board
          </Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={onRescan} disabled={loading}>
          {loading ? "…" : "Rescan"}
        </Button>
      </div>
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
  // Not `summary.upserted`: that counts the new specs plus every spec whose
  // file changed since the last sync, so reporting it is how "Create 1 card"
  // came back as "Imported 2 specs" and matched nothing the reader was shown.
  const { created, updated } = importCounts(summary);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {created > 0 ? (
          <>
            Created <strong>{created}</strong> card{created === 1 ? "" : "s"}
          </>
        ) : (
          <>No new cards to create</>
        )}
        {updated > 0 ? (
          <span className="text-muted-foreground">
            {created > 0 ? " and updated " : "; updated "}
            <strong>{updated}</strong> existing {updated === 1 ? "one" : "ones"}{" "}
            from git
          </span>
        ) : null}
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
          successHint="Now create your first spec in it below."
          onCreated={onRepoCreated}
        />
      )}
    </div>
  );
}
