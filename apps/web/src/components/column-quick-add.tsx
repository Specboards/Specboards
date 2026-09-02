"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthRequiredError } from "@/lib/api-client/request";
import { createWorkItem } from "@/lib/api-client/work-items";
import { cn } from "@/lib/utils";

/**
 * Per-column quick add: an "Add {level}" affordance pinned at the foot of a
 * board or roadmap column. Following the "Add starts as an affordance"
 * convention it begins as a single control and expands in place into a compact
 * title input with Save / Cancel; Cancel (or Esc) collapses without creating,
 * and a successful save collapses back to the affordance.
 *
 * The point is a genuinely quick add, so it only collects a title and inherits
 * the rest of its context from the column it sits in: the new item's level, its
 * product, the column's status (backlog board) and/or release (roadmap). For
 * anything richer the user opens the created card, or uses the full "New {level}"
 * drawer.
 */
export function ColumnQuickAdd({
  levelKey,
  levelLabel,
  productId,
  status,
  releaseId = null,
  parentSpecId = null,
  className,
}: {
  levelKey: string;
  levelLabel: string;
  /** Product the new item belongs to (a single product must be in scope). */
  productId: string | null;
  /** Status to stamp on the new item (the board column's status). */
  status: string;
  /** Release to schedule the new item into (the roadmap column's release). */
  releaseId?: string | null;
  /** Parent to nest the new item under, when a parent is in context. */
  parentSpecId?: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, startTransition] = useTransition();

  const label = levelLabel.toLowerCase();

  function collapse() {
    setOpen(false);
    setTitle("");
  }

  function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    startTransition(async () => {
      try {
        await createWorkItem({
          title: trimmed,
          level: levelKey,
          productId,
          status,
          releaseId,
          parentSpecId,
        });
        toast.success(`${levelLabel} created`);
        collapse();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(
          "h-8 w-full justify-start gap-1.5 text-muted-foreground",
          className,
        )}
      >
        <Plus className="h-4 w-4" />
        Add {label}
      </Button>
    );
  }

  return (
    <form
      className={cn("space-y-1.5", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            collapse();
          }
        }}
        placeholder={`${levelLabel} title`}
        className="h-8"
        aria-label={`New ${label} title`}
      />
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" className="h-7" disabled={pending}>
          {pending ? "Adding…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={collapse}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
