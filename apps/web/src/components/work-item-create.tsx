"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AuthRequiredError, createWorkItem } from "@/lib/api-client";

/**
 * "New {level}" button + drawer for creating a DB-native work item (an
 * initiative/epic — a non-leaf level). Leaf items come from spec sync, so this
 * is only rendered for non-leaf levels. `parents` are the items one level up
 * that the new item may sit under (empty when there's no parent level).
 */
export function WorkItemCreate({
  levelKey,
  levelLabel,
  parentLabel,
  parents,
}: {
  levelKey: string;
  levelLabel: string;
  /** Label of the parent level (e.g. "Initiative"), or null when top-level. */
  parentLabel: string | null;
  parents: { specId: string; title: string }[];
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
    const parentSpecId = String(data.get("parentSpecId") ?? "") || null;
    startTransition(async () => {
      setError(null);
      try {
        await createWorkItem({ title, level: levelKey, parentSpecId });
        toast.success(`${levelLabel} created`);
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
        New {levelLabel.toLowerCase()}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New {levelLabel.toLowerCase()}</SheetTitle>
          </SheetHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Title
              </span>
              <Input name="title" autoFocus className="h-8" />
            </label>
            {parentLabel ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Parent ({parentLabel.toLowerCase()})
                </span>
                <Select name="parentSpecId" defaultValue="" className="h-8">
                  <option value="">None</option>
                  {parents.map((p) => (
                    <option key={p.specId} value={p.specId}>
                      {p.title}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : `Create ${levelLabel.toLowerCase()}`}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
