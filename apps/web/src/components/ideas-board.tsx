"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ChevronUp } from "lucide-react";
import { toast } from "sonner";

import { type IdeaStage } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import { IdeaDetailSheet } from "@/components/idea-detail-sheet";
import { IdeaStatusSelect } from "@/components/idea-status-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AuthRequiredError,
  createIdea,
  setIdeaVote,
  updateIdea,
} from "@/lib/api-client";
import type { IdeaRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";

/** How the list is ordered. */
type SortKey = "votes" | "newest" | "oldest";

/**
 * The internal Ideas view: capture, vote, triage, and promote. Interactive
 * (vote/status/promote hit /api/v1 and refresh), so the whole board is a client
 * component seeded from the server-rendered list. Clicking a row opens a detail
 * drawer; a filter/sort bar narrows and orders the list.
 */
export function IdeasBoard({
  ideas,
  stages,
  canEdit,
  org,
  productSlug,
  defaultProductId,
  products,
  productsById,
}: {
  ideas: IdeaRecord[];
  stages: readonly IdeaStage[];
  canEdit: boolean;
  org: string;
  productSlug: string;
  /** Owning product for new ideas, or null in the cross-product ("all") view. */
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  /** product id → name, for cross-product tags (undefined in single-product view). */
  productsById?: Record<string, string>;
}) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("votes");
  const [detailId, setDetailId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? ideas
        : ideas.filter((i) => i.status === statusFilter);
    return [...filtered].sort((a, b) => {
      if (sort === "votes") {
        return (
          b.voteCount - a.voteCount || cmpDateDesc(a.createdAt, b.createdAt)
        );
      }
      if (sort === "newest") return cmpDateDesc(a.createdAt, b.createdAt);
      return -cmpDateDesc(a.createdAt, b.createdAt); // oldest first
    });
  }, [ideas, statusFilter, sort]);

  // The drawer reads from the live list so it reflects edits after a refresh.
  const detailIdea = detailId
    ? (ideas.find((i) => i.id === detailId) ?? null)
    : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Ideas</h1>
          <p className="text-xs text-muted-foreground">
            Capture requests and feedback, vote on what matters, and promote the
            best into feature work.
          </p>
        </div>
        {/* When the board is empty the empty state carries the only "New idea"
            CTA; show the header action once there are ideas to sit beside. */}
        {canEdit && ideas.length > 0 ? (
          <IdeaCreate
            defaultProductId={defaultProductId}
            products={products}
            showProductPicker={defaultProductId === null}
          />
        ) : null}
      </div>

      {ideas.length === 0 ? (
        <EmptyState
          title="No ideas yet"
          description="Ideas capture requests and feedback from your team and customers. Collect votes on what matters, then promote the best into feature work."
          action={
            canEdit ? (
              <IdeaCreate
                defaultProductId={defaultProductId}
                products={products}
                showProductPicker={defaultProductId === null}
              />
            ) : null
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground max-sm:w-full">
              Status
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-8 w-full sm:w-40"
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground max-sm:w-full">
              Sort
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-8 w-full sm:w-36"
                aria-label="Sort ideas"
              >
                <option value="votes">Most votes</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </Select>
            </label>
            <span className="text-xs text-muted-foreground sm:ml-auto">
              {visible.length} of {ideas.length}
            </span>
          </div>

          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No ideas match this filter.
              </p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setStatusFilter("all")}
              >
                Clear filter
              </Button>
            </div>
          ) : (
            <ul className="space-y-2">
              {visible.map((idea) => (
                <IdeaRow
                  key={idea.id}
                  idea={idea}
                  stages={stages}
                  canEdit={canEdit}
                  onOpen={() => setDetailId(idea.id)}
                  productName={
                    productsById && idea.productId
                      ? productsById[idea.productId]
                      : undefined
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}

      <IdeaDetailSheet
        idea={detailIdea}
        stages={stages}
        canEdit={canEdit}
        org={org}
        productSlug={productSlug}
        productName={
          productsById && detailIdea?.productId
            ? productsById[detailIdea.productId]
            : undefined
        }
        onClose={() => setDetailId(null)}
      />
    </section>
  );
}

/** Compare ISO timestamps, most-recent first. */
function cmpDateDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/** "New idea" button + capture drawer. */
function IdeaCreate({
  defaultProductId,
  products,
  showProductPicker,
}: {
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  showProductPicker: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    const description = String(data.get("description") ?? "").trim() || null;
    const productId = showProductPicker
      ? String(data.get("productId") ?? "") || null
      : defaultProductId;
    startTransition(async () => {
      setError(null);
      try {
        await createIdea({ title, description, productId });
        toast.success("Idea captured");
        setOpen(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Capture failed.");
      }
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New idea
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New idea</SheetTitle>
          </SheetHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Title
              </span>
              <Input
                name="title"
                autoFocus
                placeholder="e.g. Bulk-edit statuses from the board"
                className="h-8"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Details
              </span>
              <Textarea
                name="description"
                rows={5}
                placeholder="What's the request, and who's asking for it?"
              />
            </label>
            {showProductPicker && products.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Product
                </span>
                <Select name="productId" className="h-8">
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Capturing…" : "Capture idea"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * One idea in the list: vote control, a clickable title/description that opens
 * the detail drawer, and an inline status field. Promote/Delete live in the
 * drawer so the row stays a scannable status field rather than a wall of
 * look-alike buttons.
 */
function IdeaRow({
  idea,
  stages,
  canEdit,
  onOpen,
  productName,
}: {
  idea: IdeaRecord;
  stages: readonly IdeaStage[];
  canEdit: boolean;
  onOpen: () => void;
  productName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Optimistic vote state so the button reacts instantly; the server value
  // re-seeds on the next refresh.
  const [voted, setVoted] = useState(idea.viewerHasVoted);
  const [votes, setVotes] = useState(idea.voteCount);

  // Reconcile with the server after a refresh (e.g. the same idea was voted on
  // from the detail drawer). Keyed on the primitive fields so it never clobbers
  // an in-flight optimistic toggle.
  useEffect(() => {
    setVoted(idea.viewerHasVoted);
    setVotes(idea.voteCount);
  }, [idea.viewerHasVoted, idea.voteCount]);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof AuthRequiredError) {
      router.push(
        `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
      );
      return true;
    }
    return false;
  }

  function toggleVote() {
    const next = !voted;
    setVoted(next);
    setVotes((n) => n + (next ? 1 : -1));
    startTransition(async () => {
      try {
        await setIdeaVote(idea.id, next);
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
        await updateIdea(idea.id, { status });
        toast.success("Status updated");
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  const by = idea.submitterName ?? idea.authorName ?? null;

  return (
    <li className="flex items-start gap-3 rounded-md border bg-card p-3 transition-colors hover:border-foreground/20">
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

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 space-y-1 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium hover:underline">
            {idea.title}
          </span>
          {productName ? (
            <Badge variant="secondary" className="text-[10px]">
              {productName}
            </Badge>
          ) : null}
          {idea.promotedFeatureSpecId ? (
            <Badge variant="outline" className="text-[10px]">
              Promoted
            </Badge>
          ) : null}
        </div>
        {idea.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {idea.description}
          </p>
        ) : null}
        {by ? <p className="text-xs text-muted-foreground">by {by}</p> : null}
      </button>

      <IdeaStatusSelect
        status={idea.status}
        stages={stages}
        canEdit={canEdit}
        disabled={pending}
        onChange={changeStatus}
        className="shrink-0"
        ariaLabel={`Status of ${idea.title}`}
      />
    </li>
  );
}
