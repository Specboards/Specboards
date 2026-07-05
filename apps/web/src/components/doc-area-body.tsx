"use client";

import { ExternalLink, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocSpaceSetup } from "@/components/doc-space-setup";
import { DocsWorkspace } from "@/components/docs-workspace";
import { Button, buttonVariants } from "@/components/ui/button";
import type { DocPageRecord, DocSpace } from "@/lib/store/types";

/**
 * Body of a choose-your-source doc area (Research / Architecture): shows the
 * source chooser until the team picks, then the external link-out card or the
 * in-Specboard page workspace. "Change source" re-opens the chooser; changing
 * away from Specboard keeps the pages (nothing is deleted).
 */
export function DocAreaBody({
  space,
  pages,
  areaLabel,
  canEdit,
  starterTitles,
  emptyHint,
}: {
  space: DocSpace;
  pages: DocPageRecord[];
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
        onSaved={() => {
          setChoosing(false);
          router.refresh();
        }}
        onCancel={space.mode !== "unset" ? () => setChoosing(false) : undefined}
      />
    );
  }

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

  // `local` (and `github` until that slice lands, so nothing is stranded).
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {canEdit ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setChoosing(true)}
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" aria-hidden />
            Change source
          </Button>
        </div>
      ) : null}
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
