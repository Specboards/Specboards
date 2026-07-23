"use client";

import { ExternalLink, FileText, GitBranch } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthRequiredError,
  connectGithubDocSpace,
  createGithubDocSpace,
  listInstallationRepositories,
  setDocSpace,
  type InstallationRepo,
} from "@/lib/api-client";
import type { DocArea } from "@/lib/store/types";

/** What the GitHub option can do for this workspace (computed server-side). */
export interface GithubSetupState {
  /** GitHub is configured and the workspace has an org installation. */
  available: boolean;
  /** Only workspace admins may create org repositories. */
  isAdmin: boolean;
  /** Prefill for the new repo name, e.g. "webapp-research". */
  suggestedName: string;
  /** Where to send the user to install/connect the GitHub App. */
  installHref: string;
}

/**
 * First-run chooser for where an area's docs live: link out to an external
 * repository (SharePoint, Box, ...), keep pages in Specboards, or create a
 * GitHub repo of Markdown that Specboards edits and commits back. Rendered
 * until the team picks, and again when they choose "Change source".
 */
export function DocSpaceSetup({
  productId,
  area,
  areaLabel,
  github,
  onSaved,
  onCancel,
}: {
  productId: string;
  area: DocArea;
  areaLabel: string;
  github: GithubSetupState;
  /** Called with no args after the choice persists (parent refreshes). */
  onSaved: () => void;
  /** Present when a source already exists and this is a change, not setup. */
  onCancel?: () => void;
}) {
  const [externalUrl, setExternalUrl] = useState("");
  const [repoName, setRepoName] = useState(github.suggestedName);
  const [busy, setBusy] = useState<"external" | "local" | "github" | "connect" | null>(null);
  // The existing-repo picker loads lazily on request; null = not opened yet.
  const [picker, setPicker] = useState<"loading" | InstallationRepo[] | null>(null);
  const [pickedRepo, setPickedRepo] = useState("");
  const [error, setError] = useState<string | null>(null);

  function fail(err: unknown) {
    if (err instanceof AuthRequiredError) {
      window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setError(err instanceof Error ? err.message : "Save failed.");
    setBusy(null);
  }

  async function choose(mode: "external" | "local") {
    setBusy(mode);
    setError(null);
    try {
      await setDocSpace({
        productId,
        area,
        mode,
        externalUrl: mode === "external" ? externalUrl : null,
      });
      onSaved();
    } catch (err) {
      fail(err);
    }
  }

  async function createRepo() {
    setBusy("github");
    setError(null);
    try {
      await createGithubDocSpace({ productId, area, name: repoName.trim() });
      onSaved();
    } catch (err) {
      fail(err);
    }
  }

  async function openPicker() {
    setPicker("loading");
    setError(null);
    try {
      const state = await listInstallationRepositories();
      setPicker(state.repositories);
      setPickedRepo(state.repositories[0] ? repoKey(state.repositories[0]) : "");
      if (state.error) setError(state.error);
    } catch (err) {
      setPicker(null);
      fail(err);
    }
  }

  async function connectExisting() {
    const repo = Array.isArray(picker)
      ? picker.find((r) => repoKey(r) === pickedRepo)
      : undefined;
    if (!repo) return;
    setBusy("connect");
    setError(null);
    try {
      await connectGithubDocSpace({
        productId,
        area,
        owner: repo.owner,
        name: repo.name,
        installationId: repo.installationId,
      });
      onSaved();
    } catch (err) {
      fail(err);
    }
  }

  const canCreateRepo = github.available && github.isAdmin;

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Where does your {areaLabel.toLowerCase()} live?</h2>
        <p className="text-sm text-muted-foreground">
          Choose once per product. You can change this later.
        </p>
      </div>

      <div className="space-y-3">
        <div className="rounded-md border p-4">
          <div className="flex items-start gap-3">
            <ExternalLink className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">Connect an external repository</p>
                <p className="text-sm text-muted-foreground">
                  Your team already keeps {areaLabel.toLowerCase()} in SharePoint, Box,
                  Confluence, or similar. Specboards links out to it.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={externalUrl}
                  onChange={(e) => setExternalUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="External repository URL"
                />
                <Button
                  onClick={() => void choose("external")}
                  disabled={busy !== null || !externalUrl.trim()}
                >
                  {busy === "external" ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-md border p-4">
          <div className="flex items-start gap-3">
            <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">Keep it in Specboards</p>
                <p className="text-sm text-muted-foreground">
                  Write and organize pages right here, with folders and rich text
                  editing.
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => void choose("local")}
                disabled={busy !== null}
              >
                {busy === "local" ? "Setting up…" : "Use Specboards"}
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-md border p-4">
          <div className="flex items-start gap-3">
            <GitBranch className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
            <div className="flex-1 space-y-2">
              <div>
                <p className="text-sm font-medium">Use a GitHub repository</p>
                <p className="text-sm text-muted-foreground">
                  Docs live as Markdown files in a repo your org owns. Edit them
                  here; every save commits back to the repo.
                </p>
              </div>
              {canCreateRepo ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={repoName}
                      onChange={(e) => setRepoName(e.target.value)}
                      aria-label="New repository name"
                    />
                    <Button
                      variant="secondary"
                      onClick={() => void createRepo()}
                      disabled={busy !== null || !repoName.trim()}
                    >
                      {busy === "github" ? "Creating…" : "Create repository"}
                    </Button>
                  </div>
                  {picker === null ? (
                    <Button
                      variant="link"
                      size="inline"
                      onClick={() => void openPicker()}
                      className="text-sm underline"
                    >
                      Or connect an existing repository
                    </Button>
                  ) : picker === "loading" ? (
                    <p className="text-sm text-muted-foreground">Loading repositories…</p>
                  ) : picker.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      The GitHub App can&apos;t access any repositories yet. Grant it
                      access on GitHub, then try again.
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={pickedRepo}
                        onChange={(e) => setPickedRepo(e.target.value)}
                        aria-label="Existing repository"
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
                      >
                        {picker.map((repo) => (
                          <option key={repoKey(repo)} value={repoKey(repo)}>
                            {repo.owner}/{repo.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="secondary"
                        onClick={() => void connectExisting()}
                        disabled={busy !== null || !pickedRepo}
                      >
                        {busy === "connect" ? "Connecting…" : "Connect repository"}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {github.available ? (
                    "Only a workspace admin can connect a repository."
                  ) : (
                    <>
                      <Link href={github.installHref} className="underline hover:text-foreground">
                        Connect the GitHub App
                      </Link>{" "}
                      to an organization first.
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function repoKey(repo: InstallationRepo): string {
  return `${repo.installationId}:${repo.owner}/${repo.name}`;
}
