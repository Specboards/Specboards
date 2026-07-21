"use client";

import { ExternalLink, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocSpaceSetup, type GithubSetupState } from "@/components/doc-space-setup";
import { DocsWorkspace } from "@/components/docs-workspace";
import {
  GithubDocsWorkspace,
  type GithubDocFileView,
} from "@/components/github-docs-workspace";
import { Button, buttonVariants } from "@/components/ui/button";
import type { DocPageRecord, DocSpace } from "@/lib/store/types";

/** GitHub-backed area data resolved server-side, or why it couldn't be. */
export type GithubDocsData =
  | { repoFullName: string; repoUrl: string; files: GithubDocFileView[] }
  | { error: string };

/**
 * Body of a choose-your-source doc area (Research / Architecture): shows the
 * source chooser until the team picks, then the external link-out card, the
 * in-Specboards page workspace, or the GitHub-backed file workspace. "Change
 * source" re-opens the chooser; changing away from a source keeps its content
 * (Specboards pages stay in the database, repo files stay in the repo).
 */
export function DocAreaBody({
  space,
  pages,
  github,
  githubSetup,
  areaLabel,
  canEdit,
  starterTitles,
  emptyHint,
}: {
  space: DocSpace;
  pages: DocPageRecord[];
  /** Present only when the space is GitHub-backed. */
  github?: GithubDocsData;
  githubSetup: GithubSetupState;
  areaLabel: string;
  canEdit: boolean;
  starterTitles?: string[];
  emptyHint?: string;
}) {
  const router = useRouter();
  const [choosing, setChoosing] = useState(false);

  if (space.mode === "unset" || choosing) {
    if (!canEdit && space.mode === "unset") {
      return (
        <p className="py-16 text-center text-sm text-muted-foreground">
          The team hasn&apos;t set up {areaLabel.toLowerCase()} for this product yet.
        </p>
      );
    }
    return (
      <DocSpaceSetup
        productId={space.productId}
        area={space.area}
        areaLabel={areaLabel}
        github={githubSetup}
        onSaved={() => {
          setChoosing(false);
          router.refresh();
        }}
        onCancel={space.mode !== "unset" ? () => setChoosing(false) : undefined}
      />
    );
  }

  const changeSource = canEdit ? (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={() => setChoosing(true)}
    >
      <Settings2 className="mr-1 h-3.5 w-3.5" aria-hidden />
      Change source
    </Button>
  ) : null;

  if (space.mode === "external") {
    return (
      <div className="mx-auto max-w-md space-y-3 py-16 text-center">
        <p className="text-sm font-medium">
          Your {areaLabel.toLowerCase()} lives in an external repository.
        </p>
        <p className="break-all text-sm text-muted-foreground">{space.externalUrl}</p>
        <div className="flex justify-center gap-2 pt-1">
          <a
            href={space.externalUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({})}
          >
            <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />
            Open repository
          </a>
          {canEdit ? (
            <Button variant="ghost" onClick={() => setChoosing(true)}>
              Change source
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (space.mode === "github") {
    if (!github || "error" in github) {
      return (
        <div className="mx-auto max-w-md space-y-3 py-16 text-center">
          <p className="text-sm font-medium">
            Couldn&apos;t load the {areaLabel.toLowerCase()} repository.
          </p>
          <p className="text-sm text-muted-foreground">
            {github && "error" in github ? github.error : "The repository is unavailable."}
          </p>
          {canEdit ? (
            <Button variant="ghost" onClick={() => setChoosing(true)}>
              Change source
            </Button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {changeSource ? <div className="flex justify-end">{changeSource}</div> : null}
        <GithubDocsWorkspace
          key={`${space.repoId}`}
          productId={space.productId}
          area={space.area}
          repoFullName={github.repoFullName}
          repoUrl={github.repoUrl}
          initialFiles={github.files}
          canEdit={canEdit}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {changeSource ? <div className="flex justify-end">{changeSource}</div> : null}
      <DocsWorkspace
        key={space.mode}
        productId={space.productId}
        area={space.area}
        initialPages={pages}
        canEdit={canEdit}
        starterTitles={starterTitles}
        emptyHint={emptyHint}
      />
    </div>
  );
}
