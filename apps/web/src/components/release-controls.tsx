"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { AuthRequiredError, createRelease } from "@/lib/api-client";

/**
 * "New release" button + drawer on the Roadmap. A release belongs to a product
 * (the roadmap's product, passed as `productId`) or, on the aggregate roadmap,
 * is a workspace-wide portfolio release (`productId` null). Items are scheduled
 * into one by dragging their card into the release column (or from an item's
 * detail page). Editing, shipping, and deleting a release all live in its detail
 * panel (open it from the column heading), not here.
 */
export function ReleaseCreate({ productId }: { productId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const startDate = String(data.get("startDate") ?? "") || null;
    const targetDate = String(data.get("targetDate") ?? "") || null;
    const notes = String(data.get("notes") ?? "").trim() || null;
    startTransition(async () => {
      setError(null);
      try {
        await createRelease({ name, productId, startDate, targetDate, notes });
        toast.success("Release created");
        setOpen(false);
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
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        New release
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New release</SheetTitle>
          </SheetHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Name
              </span>
              <Input name="name" autoFocus placeholder="e.g. v0.4" className="h-8" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Start date
                </span>
                <Input name="startDate" type="date" className="h-8" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Ship date
                </span>
                <Input name="targetDate" type="date" className="h-8" />
              </label>
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Notes
              </span>
              <Textarea
                name="notes"
                rows={4}
                placeholder="Scope, theme, or anything worth noting about this release."
              />
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : "Create release"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
