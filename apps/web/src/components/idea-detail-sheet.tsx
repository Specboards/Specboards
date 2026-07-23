"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChevronUp } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import type { IdeaStage } from "@specboards/core";

import { IdeaStatusSelect } from "@/components/idea-status-select";
import { Badge } from "@/components/ui/badge";
import { Box, BoxHeader } from "@/components/ui/box";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  AuthRequiredError,
  deleteIdea,
  promoteIdea,
  setIdeaVote,
  updateIdea,
} from "@/lib/api-client";
import { orgProductPath } from "@/lib/org-path";
import type { IdeaRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";

/** Format an ISO timestamp as a short, locale-aware date. */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/**
 * Full detail view for a single idea, opened by clicking its row. Mirrors the
 * feature flyout: it reads the record the list already holds (no extra fetch),
 * renders the description as Markdown, and lets editors change status, edit the
 * title/details, vote, promote, or delete. Every mutation refreshes so the list
 * behind the drawer stays in sync.
 */
export function IdeaDetailSheet({
  idea,
  stages,
  canEdit,
  org,
  productSlug,
  productName,
  onClose,
}: {
  /** The idea to show, or null when the drawer is closed. */
  idea: IdeaRecord | null;
  stages: readonly IdeaStage[];
  canEdit: boolean;
  org: string;
  productSlug: string;
  productName?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Optimistic vote state, re-seeded whenever a different idea opens.
  const [voted, setVoted] = useState(false);
  const [votes, setVotes] = useState(0);

  // Return to view mode when the drawer opens on a different idea. Keyed on the
  // id (not the whole record) so an in-flight vote refresh doesn't kick the user
  // out of an unsaved edit.
  useEffect(() => {
    setEditing(false);
  }, [idea?.id]);

  // Reconcile the optimistic vote with the server after each refresh. Depending
  // on the primitive fields (not the record identity) means it only fires when
  // the server value actually changes, never mid-optimistic-update.
  useEffect(() => {
    if (!idea) return;
    setVoted(idea.viewerHasVoted);
    setVotes(idea.voteCount);
  }, [idea?.viewerHasVoted, idea?.voteCount, idea]);

  function startEdit() {
    if (!idea) return;
    setTitle(idea.title);
    setDescription(idea.description ?? "");
    setEditing(true);
  }

  function handleAuthError(err: unknown): boolean {
    if (err instanceof AuthRequiredError) {
      router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
      return true;
    }
    return false;
  }

  if (!idea) {
    return (
      <Sheet open={false} onOpenChange={(open) => !open && onClose()}>
        <SheetContent />
      </Sheet>
    );
  }
  const current = idea;

  function toggleVote() {
    const next = !voted;
    setVoted(next);
    setVotes((n) => n + (next ? 1 : -1));
    startTransition(async () => {
      try {
        await setIdeaVote(current.id, next);
        router.refresh();
      } catch (err) {
        setVoted(!next);
        setVotes((n) => n + (next ? -1 : 1));
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Vote failed.");
      }
    });
  }

  function changeStatus(status: string) {
    startTransition(async () => {
      try {
        await updateIdea(current.id, { status });
        toast.success("Status updated");
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  function saveEdits() {
    const nextTitle = title.trim();
    if (!nextTitle) {
      toast.error("Title is required.");
      return;
    }
    startTransition(async () => {
      try {
        await updateIdea(current.id, {
          title: nextTitle,
          description: description.trim() || null,
        });
        toast.success("Idea updated");
        setEditing(false);
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  function promote() {
    if (
      !window.confirm(
        `Promote "${current.title}" into a feature? It's added to the backlog and linked back here.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await promoteIdea(current.id);
        toast.success("Promoted to a feature");
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Promote failed.");
      }
    });
  }

  function remove() {
    if (
      !window.confirm(`Delete the idea "${current.title}"? This can't be undone.`)
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteIdea(current.id);
        toast.success("Idea deleted");
        onClose();
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  const promotedHref = current.promotedFeatureSpecId
    ? orgProductPath(org, productSlug, `/backlog/${current.promotedFeatureSpecId}`)
    : null;
  const by = current.submitterName ?? current.authorName ?? null;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-5 py-3">
          <SheetTitle className="sr-only">{current.title}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Vote + status + product: the always-interactive header row. */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleVote}
              disabled={pending}
              aria-pressed={voted}
              aria-label={voted ? "Remove your vote" : "Vote for this idea"}
              className={cn(
                "flex w-12 shrink-0 flex-col items-center rounded-md border py-1 transition-colors",
                voted
                  ? "border-link bg-link/10 text-link"
                  : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              <ChevronUp className="size-4" />
              <span className="text-sm font-semibold tabular-nums">{votes}</span>
            </button>
            <IdeaStatusSelect
              status={current.status}
              stages={stages}
              canEdit={canEdit}
              disabled={pending}
              onChange={changeStatus}
              ariaLabel={`Status of ${current.title}`}
            />
            {productName ? (
              <Badge variant="secondary" className="text-[10px]">
                {productName}
              </Badge>
            ) : null}
          </div>

          {editing ? (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Title
                </span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="h-8"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Details
                </span>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                  placeholder="What's the request, and who's asking for it?"
                />
              </label>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={saveEdits} disabled={pending}>
                  {pending ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold tracking-tight">
                {current.title}
              </h2>
              <Box>
                <BoxHeader className="flex-wrap gap-x-3 text-xs font-normal text-muted-foreground">
                  {by ? <span>by {by}</span> : null}
                  <span>{formatDate(current.createdAt)}</span>
                </BoxHeader>
                <div className="px-4 py-3">
                  {current.description ? (
                    <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                      <ReactMarkdown>{current.description}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No details yet.
                    </p>
                  )}
                </div>
              </Box>
              {promotedHref ? (
                <Link
                  href={promotedHref}
                  className="inline-block text-sm text-link hover:underline"
                >
                  Promoted → {current.promotedFeatureTitle ?? "feature"}
                </Link>
              ) : null}
            </>
          )}
        </div>

        {canEdit && !editing ? (
          <div className="flex items-center gap-2 border-t px-5 py-3">
            <Button size="sm" variant="outline" onClick={startEdit}>
              Edit
            </Button>
            {!current.promotedFeatureSpecId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={promote}
                disabled={pending}
              >
                Promote
              </Button>
            ) : null}
            <Button
              variant="link"
              size="inline"
              onClick={remove}
              disabled={pending}
              className="ml-auto text-xs font-normal text-muted-foreground underline-offset-2 hover:text-destructive"
            >
              Delete
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
