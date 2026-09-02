"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  type CreatedSpecRepo,
  createSpecRepository,
} from "@/lib/api-client/repositories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Creating a dedicated spec repository, rather than connecting an existing one.
 *
 * Its own module because two flows offer it. Onboarding shows it when a
 * connected repository turns out to hold no specs, and the connect section
 * shows it when there is nothing connected at all. Both are the same answer to
 * the same problem: the reader has nowhere to put a spec yet, and picking a
 * repository from a list will not fix that.
 */

/**
 * Nudge for users who'd rather keep specs in their own repository. With a
 * pending organization installation we can create and connect the repo in one
 * click (the App's repository Administration permission); otherwise, or when
 * that fails, the manual steps remain: deep-link to GitHub's new-repo page,
 * install the App on it, connect it here. Shown in the two "no suitable repo"
 * moments: the connect section (nothing connected) and the empty-specs
 * first-spec state.
 */
export function CreateSpecRepoNudge({
  installUrl,
  orgInstallationId,
  onCreated,
}: {
  installUrl: string | null;
  /** Organization installation to create in; null hides the one-click form. */
  orgInstallationId: string | null;
  /** Called after a repo is created + connected, so parent panels refresh. */
  onCreated: (repo?: CreatedSpecRepo) => void;
}) {
  const newRepoUrl =
    "https://github.com/new?name=specs&description=" +
    encodeURIComponent("Product specs synced to Specboards");
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        Prefer a dedicated repo just for specs?
      </summary>
      <div className="mt-3 space-y-3 text-xs text-muted-foreground">
        <p>
          Keep your specs in their own repository, separate from application
          code.
        </p>
        {orgInstallationId ? (
          <CreateSpecRepoForm
            installationId={orgInstallationId}
            onCreated={onCreated}
          />
        ) : null}
        {orgInstallationId ? (
          <p className="font-medium">Or do it yourself:</p>
        ) : null}
        <ol className="list-decimal space-y-1 pl-4">
          <li>
            <a
              href={newRepoUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Create a repo on GitHub
            </a>{" "}
            (we suggest naming it <code>specs</code>).
          </li>
          <li>
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Install Specboards
              </a>
            ) : (
              "Install the Specboards GitHub App"
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
 * One-click path of the spec-repo nudge: name the repo and Specboards creates a
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
  onCreated: (repo?: CreatedSpecRepo) => void;
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
        const result = await createSpecRepository({
          name: repoName,
          installationId,
        });
        setCreated(result);
        // Hand the repo up before asking for a refresh: the parent can show it
        // immediately, so the success message and the list above never
        // disagree while the server render is still in flight.
        onCreated(result);
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't create the repository.",
        );
      }
    });
  }

  if (created) {
    return (
      <p>
        Created and connected{" "}
        <a
          href={created.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {created.owner}/{created.name}
        </a>
        . Now create your first spec in it below.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <p>
        We can create a private repo in your GitHub organization and connect it
        for you.
      </p>
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
