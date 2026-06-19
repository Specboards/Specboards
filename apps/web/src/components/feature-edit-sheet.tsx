"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { EstimateConfig, RepoConfig, StatusWorkflow } from "@specboard/core";

import { FeatureGithubLinks } from "@/components/feature-github-links";
import { FeatureMetaForm } from "@/components/feature-meta-form";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AuthRequiredError, getFeature } from "@/lib/api-client";
import type { FeatureDetail } from "@/lib/store/types";
import { useOrgProductPath } from "@/lib/use-org";
import type { WorkspaceMember } from "@/lib/workspace";

type FieldDef = RepoConfig["fields"][number];

/**
 * In-context editor: opens a drawer for `specId`, loads its full detail, and
 * reuses {@link FeatureMetaForm}. Lets users edit a card without leaving the
 * board. `candidates` are parent options (filtered to exclude the open card).
 */
export function FeatureEditSheet({
  specId,
  onClose,
  members,
  customFields,
  candidates,
  estimate,
  workflow,
  canEdit,
}: {
  /** The feature to edit, or null when the drawer is closed. */
  specId: string | null;
  onClose: () => void;
  members: WorkspaceMember[];
  customFields: FieldDef[];
  candidates: { specId: string; title: string }[];
  estimate: EstimateConfig;
  workflow?: StatusWorkflow;
  canEdit: boolean;
}) {
  const [feature, setFeature] = useState<FeatureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orgHref = useOrgProductPath();

  useEffect(() => {
    if (!specId) {
      setFeature(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setFeature(null);
    setError(null);
    getFeature(specId)
      .then((f) => {
        if (!cancelled) setFeature(f);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthRequiredError) {
          window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load feature.");
      });
    return () => {
      cancelled = true;
    };
  }, [specId]);

  return (
    <Sheet open={specId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{feature?.title ?? "Loading…"}</SheetTitle>
          {feature ? (
            <SheetDescription>
              <Link href={orgHref(`/backlog/${feature.specId}`)} className="hover:underline">
                Open full spec →
              </Link>
            </SheetDescription>
          ) : null}
        </SheetHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : feature ? (
          <>
            <FeatureMetaForm
              feature={feature}
              members={members}
              customFields={customFields}
              candidates={candidates.filter((c) => c.specId !== feature.specId)}
              estimate={estimate}
              workflow={workflow}
              canEdit={canEdit}
              onSaved={() => {
                toast.success("Saved");
                onClose();
              }}
            />
            <Separator />
            <FeatureGithubLinks
              specId={feature.specId}
              links={feature.githubLinks}
              canEdit={canEdit}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
