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
import {
  AuthRequiredError,
  createRelease,
  deleteRelease,
  updateRelease,
} from "@/lib/api-client";
import { RELEASE_STATUSES, type ReleaseStatus } from "@/lib/store/types";

const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/**
 * "New release" button + drawer on the Roadmap. Releases are workspace-wide
 * ship vehicles; items are scheduled into one from their detail page or the
 * board edit drawer.
 */
export function ReleaseCreate() {
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
    startTransition(async () => {
      setError(null);
      try {
        await createRelease({ name, startDate, targetDate });
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

/**
 * Per-release edit drawer (admin): rename, change ship status, and set/clear
 * the target date. Opened from the "Edit" control beside each release heading.
 */
export function ReleaseEdit({
  id,
  name,
  status,
  startDate,
  targetDate,
}: {
  id: string;
  name: string;
  status: ReleaseStatus;
  startDate: string | null;
  targetDate: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const nextName = String(data.get("name") ?? "").trim();
    if (!nextName) {
      setError("Name is required.");
      return;
    }
    const nextStatus = String(data.get("status") ?? "planned") as ReleaseStatus;
    const nextStartDate = String(data.get("startDate") ?? "") || null;
    const nextTargetDate = String(data.get("targetDate") ?? "") || null;
    startTransition(async () => {
      setError(null);
      try {
        await updateRelease(id, {
          name: nextName,
          status: nextStatus,
          startDate: nextStartDate,
          targetDate: nextTargetDate,
        });
        toast.success("Release saved");
        setOpen(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        aria-label={`Edit release ${name}`}
      >
        Edit
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit release</SheetTitle>
          </SheetHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Name
              </span>
              <Input
                name="name"
                autoFocus
                defaultValue={name}
                className="h-8"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Status
              </span>
              <Select name="status" defaultValue={status} className="h-8">
                {RELEASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RELEASE_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Start date
                </span>
                <Input
                  name="startDate"
                  type="date"
                  defaultValue={startDate ?? ""}
                  className="h-8"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Ship date
                </span>
                <Input
                  name="targetDate"
                  type="date"
                  defaultValue={targetDate ?? ""}
                  className="h-8"
                />
              </label>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Small per-release delete control (admin); items are unscheduled, not deleted. */
export function ReleaseDelete({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (
      !window.confirm(
        `Delete the "${name}" release? Its items stay on the board, unscheduled.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteRelease(id);
        toast.success("Release deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={pending}
      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      aria-label={`Delete release ${name}`}
    >
      Delete
    </button>
  );
}

/**
 * Mark a release shipped ("Release" action). Shipped releases (and their items)
 * drop off the active roadmap and move to the Shipped releases view; the items
 * keep their release assignment for history.
 */
export function ReleaseShip({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onShip() {
    if (
      !window.confirm(
        `Mark "${name}" as released? It moves to Shipped releases and leaves the active roadmap.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await updateRelease(id, { status: "shipped" });
        toast.success(`${name} released`);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Release failed.");
      }
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={onShip} disabled={pending}>
      {pending ? "Releasing…" : "Release"}
    </Button>
  );
}

/** Reopen a shipped release back to Planned, returning it to the active roadmap. */
export function ReleaseReopen({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onReopen() {
    startTransition(async () => {
      try {
        await updateRelease(id, { status: "planned" });
        toast.success(`${name} reopened`);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Reopen failed.");
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onReopen}
      disabled={pending}
      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      aria-label={`Reopen release ${name}`}
    >
      Reopen
    </button>
  );
}
