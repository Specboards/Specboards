"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  connectRepository,
  disconnectRepository,
  type RepoProductLinksPayload,
  setRepositoryProducts,
  updateRepository,
} from "@/lib/api-client/repositories";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
  type ConnectedRepo,
  type RepoProductOption,
  type Status,
  syncMessage,
} from "@/components/repositories-manager/shared";

/**
 * A connected repository, and what an admin can change about it.
 *
 * The list of what is already connected, plus the two things you can adjust
 * per repository once it is: which products its specs belong to, and whether
 * Specboards writes to it through a pull request or straight to the branch.
 *
 * Connecting a new repository is a different flow and lives in `connect`.
 */

export function RepoList({
  repos,
  canResync,
  canManage,
  products,
  links,
}: {
  repos: ConnectedRepo[];
  canResync: boolean;
  canManage: boolean;
  products: RepoProductOption[];
  links: Record<string, RepoProductLinksPayload>;
}) {
  if (repos.length === 0) {
    return (
      <EmptyState
        title="No repositories connected"
        description={
          canManage
            ? "Specboards reads your specs from a connected GitHub repository. Connect one using the section below to import every spec and keep this list in sync on each push."
            : "Specboards reads your specs from a connected GitHub repository. Once an admin connects one, it appears here."
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      {repos.map((repo) => (
        <RepoRow
          key={repo.id}
          repo={repo}
          canResync={canResync}
          canManage={canManage}
          products={products}
          links={links[repo.id] ?? null}
        />
      ))}
    </div>
  );
}

function RepoRow({
  repo,
  canResync,
  canManage,
  products,
  links: initialLinks,
}: {
  repo: ConnectedRepo;
  canResync: boolean;
  canManage: boolean;
  products: RepoProductOption[];
  links: RepoProductLinksPayload | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);
  const [confirming, setConfirming] = useState(false);
  const [editingProducts, setEditingProducts] = useState(false);
  const [links, setLinks] = useState(initialLinks);

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
        setStatus(
          sync ? syncMessage(sync) : { kind: "ok", message: "Re-synced." },
        );
        router.refresh();
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : "Re-sync failed.",
        });
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

  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const linkedNames = (links?.productIds ?? [])
    .map((id) => ({
      id,
      name: nameById.get(id) ?? "Unknown product",
      isDefault: id === links?.defaultProductId,
    }))
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name),
    );

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {repo.owner}/{repo.name}
            </p>
            <p className="text-xs text-muted-foreground">
              Branch <code>{repo.defaultBranch}</code>
              {status ? (
                <>
                  {" · "}
                  <span
                    className={
                      status.kind === "error" ? "text-destructive" : ""
                    }
                  >
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
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={disconnect}
                  disabled={pending}
                >
                  {pending ? "…" : "Disconnect"}
                </Button>
              </>
            ) : (
              <>
                {canManage && products.length > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingProducts((v) => !v)}
                    disabled={pending}
                  >
                    Products
                  </Button>
                ) : null}
                {canResync ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={resync}
                    disabled={pending}
                  >
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
        </div>
        {linkedNames.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {linkedNames.map((p) => (
              <span key={p.id} className="rounded-full border px-2 py-0.5">
                {p.name}
                {p.isDefault ? " ★" : ""}
              </span>
            ))}
            <span>★ = new specs land here</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Unassigned: new specs land in the workspace&apos;s default product.
          </p>
        )}
        <RepoWriteMode repo={repo} canManage={canManage} />
        {editingProducts && canManage ? (
          <RepoProductsEditor
            repoId={repo.id}
            products={products}
            links={links}
            onSaved={(next) => {
              setLinks(next);
              setEditingProducts(false);
            }}
            onCancel={() => setEditingProducts(false)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * How spec edits made in the app reach this repo, and who decided.
 *
 * The setting's real home is the repo's own `.specboards/config.yml`, where it
 * is versioned with the code. This is the escape hatch for the case that home
 * is unreachable: an admin connecting a repository they cannot commit to would
 * otherwise have to open a pull request in order to change how pull requests
 * are made.
 *
 * Where the value came from is shown, not just the value. "Why are my saves
 * going straight to main?" is a question the UI should be able to answer
 * without anyone opening a YAML file.
 */
function RepoWriteMode({
  repo,
  canManage,
}: {
  repo: ConnectedRepo;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [override, setOverride] = useState(repo.writeModeOverride ?? null);
  const [error, setError] = useState<string | null>(null);

  const fromConfig =
    repo.config?.writeMode === "pr" || repo.config?.writeMode === "direct"
      ? repo.config.writeMode
      : null;
  const effective = override ?? fromConfig ?? "pr";
  const source = override
    ? "set here"
    : fromConfig
      ? "from .specboards/config.yml"
      : "the default";

  function choose(next: "pr" | "direct" | "") {
    const value = next === "" ? null : next;
    setError(null);
    setOverride(value);
    startTransition(async () => {
      try {
        await updateRepository(repo.id, { writeModeOverride: value });
        router.refresh();
      } catch (err) {
        // Put the control back where it was: leaving it showing a choice the
        // server rejected would misreport what this repo actually does.
        setOverride(repo.writeModeOverride ?? null);
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        Spec edits{" "}
        {effective === "pr"
          ? "open a pull request for review"
          : "commit straight to the default branch"}{" "}
        ({source}).
      </span>
      {canManage ? (
        <>
          <label className="sr-only" htmlFor={`write-mode-${repo.id}`}>
            Write mode for {repo.owner}/{repo.name}
          </label>
          <Select
            id={`write-mode-${repo.id}`}
            className="h-7 w-auto text-xs"
            value={override ?? ""}
            disabled={pending}
            onChange={(e) => choose(e.target.value as "pr" | "direct" | "")}
          >
            <option value="">Use the repo&apos;s config</option>
            <option value="pr">Always ask for review</option>
            <option value="direct">Always commit directly</option>
          </Select>
        </>
      ) : null}
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  );
}

/**
 * Inline editor for a repo's product links: check the products this repo
 * feeds, pick the default (where sync puts newly discovered specs). Clearing
 * every product is allowed; the repo then falls back to the workspace's
 * default product.
 */
function RepoProductsEditor({
  repoId,
  products,
  links,
  onSaved,
  onCancel,
}: {
  repoId: string;
  products: RepoProductOption[];
  links: RepoProductLinksPayload | null;
  onSaved: (links: RepoProductLinksPayload) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(links?.productIds ?? []),
  );
  const [defaultId, setDefaultId] = useState<string | null>(
    links?.defaultProductId ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // The default must stay one of the linked products.
        if (defaultId === id) {
          setDefaultId([...next][0] ?? null);
        }
      } else {
        next.add(id);
        if (!defaultId) setDefaultId(id);
      }
      return next;
    });
  }

  function onSave() {
    startTransition(async () => {
      setError(null);
      try {
        const next = await setRepositoryProducts(repoId, {
          productIds: [...selected],
          defaultProductId: selected.size > 0 ? defaultId : null,
        });
        onSaved(next);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Products this repo feeds; the default is where its new specs land.
      </p>
      <ul className="space-y-1">
        {products.map((p) => {
          const checked = selected.has(p.id);
          return (
            <li key={p.id} className="flex items-center gap-3 text-sm">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(p.id)}
                />
                {p.name}
              </label>
              <label
                className={`flex items-center gap-1 text-xs ${
                  checked ? "text-muted-foreground" : "text-muted-foreground/40"
                }`}
              >
                <input
                  type="radio"
                  name={`default-${repoId}`}
                  checked={defaultId === p.id}
                  disabled={!checked}
                  onChange={() => setDefaultId(p.id)}
                />
                default
              </label>
            </li>
          );
        })}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
