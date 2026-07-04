"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import type { StatusWorkflow } from "@specboard/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AuthRequiredError, createWorkItem } from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import type { WorkspaceMember } from "@/lib/workspace";

/**
 * "Generate {child}" action on a parent item: quickly create child items one
 * level down (Initiative → Epic, Epic → Feature, Feature → Work item) with the
 * parent pre-selected. The drawer stays open after each create so several
 * children can be added in a row. This is a manual flow today; an AI-assisted
 * generator can slot in behind the same button later.
 */
export function GenerateChildButton({
  parentSpecId,
  parentTitle,
  childLevelKey,
  childLevelLabel,
  productId,
  workflow,
  members = [],
}: {
  parentSpecId: string;
  parentTitle: string;
  childLevelKey: string;
  childLevelLabel: string;
  /** Product the children inherit from the parent. */
  productId: string | null;
  workflow: StatusWorkflow;
  members?: WorkspaceMember[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const defaultStatus = workflow.statuses[0] ?? "backlog";
  const label = childLevelLabel.toLowerCase();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    if (!title) {
      setError("Title is required.");
      return;
    }
    const status = String(data.get("status") ?? defaultStatus) || defaultStatus;
    const assigneeId = String(data.get("assigneeId") ?? "") || null;
    startTransition(async () => {
      setError(null);
      try {
        await createWorkItem({
          title,
          level: childLevelKey,
          parentSpecId,
          productId,
          status,
          assigneeId,
        });
        setAdded((n) => n + 1);
        // Clear the form back to its defaults and refocus so the next child can
        // be typed straight away.
        form.reset();
        inputRef.current?.focus();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => {
          setAdded(0);
          setError(null);
          setOpen(true);
        }}
      >
        <Plus className="size-3.5" />
        Generate {childLevelLabel}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Generate {label}</SheetTitle>
            <SheetDescription>
              New {label} items under “{parentTitle}”.
              {added > 0
                ? ` ${added} added.`
                : ""}
            </SheetDescription>
          </SheetHeader>
          <form key="generate-child" onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Title
              </span>
              <Input ref={inputRef} name="title" autoFocus className="h-8" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Status
              </span>
              <Select name="status" defaultValue={defaultStatus} className="h-8">
                {workflow.statuses.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </label>
            {members.length > 0 ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Assigned to
                </span>
                <Select name="assigneeId" defaultValue="" className="h-8">
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Adding…" : `Add ${label}`}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
