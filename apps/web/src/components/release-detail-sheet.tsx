"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  AuthRequiredError,
  deleteRelease,
  updateRelease,
} from "@/lib/api-client";
import {
  RELEASE_STATUSES,
  type ReleaseRecord,
  type ReleaseStatus,
} from "@/lib/store/types";

const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/** Render a release's date range as "start → ship", omitting missing ends. */
function formatReleaseDates(
  startDate: string | null,
  targetDate: string | null,
): string | null {
  if (startDate && targetDate) return `${startDate} → ${targetDate}`;
  if (targetDate) return `→ ${targetDate}`;
  if (startDate) return `${startDate} →`;
  return null;
}

/**
 * Release detail panel, opened from a column heading on the Roadmap. Shows the
 * release's dates, status, item count, and Markdown notes, and (for admins) is
 * the single home for the Release / Edit / Delete actions that used to crowd
 * the column heading. Edit happens inline here rather than in a separate drawer.
 */
export function ReleaseDetailSheet({
  release,
  isAdmin,
  onClose,
}: {
  /** The release to show, or null when the panel is closed. */
  release: ReleaseRecord | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: "",
    status: "planned" as ReleaseStatus,
    startDate: "",
    targetDate: "",
    notes: "",
  });

  // Leave edit mode when the panel opens on a different release.
  useEffect(() => {
    setEditing(false);
  }, [release?.id]);

  function handleAuthError(err: unknown): boolean {
    if (err instanceof AuthRequiredError) {
      router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
      return true;
    }
    return false;
  }

  if (!release) {
    return (
      <Sheet open={false} onOpenChange={(open) => !open && onClose()}>
        <SheetContent />
      </Sheet>
    );
  }
  const current = release;

  function startEdit() {
    setForm({
      name: current.name,
      status: current.status,
      startDate: current.startDate ?? "",
      targetDate: current.targetDate ?? "",
      notes: current.notes ?? "",
    });
    setEditing(true);
  }

  function saveEdits() {
    const name = form.name.trim();
    if (!name) {
      toast.error("Name is required.");
      return;
    }
    startTransition(async () => {
      try {
        await updateRelease(current.id, {
          name,
          status: form.status,
          startDate: form.startDate || null,
          targetDate: form.targetDate || null,
          notes: form.notes.trim() || null,
        });
        toast.success("Release saved");
        setEditing(false);
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  function setStatus(status: ReleaseStatus, confirmMsg?: string, successMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    startTransition(async () => {
      try {
        await updateRelease(current.id, { status });
        toast.success(successMsg ?? "Release updated");
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  function remove() {
    if (
      !window.confirm(
        `Delete the "${current.name}" release? Its items stay on the board, unscheduled.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteRelease(current.id);
        toast.success("Release deleted");
        onClose();
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  const dates = formatReleaseDates(current.startDate, current.targetDate);
  const shipped = current.status === "shipped";

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-lg">
        {/* Visible title, padded clear of the sheet's top-right close button so
            the two don't collide on the header's bottom border. */}
        <SheetHeader className="border-b px-5 py-3 pr-12">
          <SheetTitle className="truncate">{current.name}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {editing ? (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Name
                </span>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-8"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Status
                </span>
                <Select
                  value={form.status}
                  onChange={(e) =>
                    setForm({ ...form, status: e.target.value as ReleaseStatus })
                  }
                  className="h-8"
                >
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
                    type="date"
                    value={form.startDate}
                    onChange={(e) =>
                      setForm({ ...form, startDate: e.target.value })
                    }
                    className="h-8"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Ship date
                  </span>
                  <Input
                    type="date"
                    value={form.targetDate}
                    onChange={(e) =>
                      setForm({ ...form, targetDate: e.target.value })
                    }
                    className="h-8"
                  />
                </label>
              </div>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Notes
                </span>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={8}
                  placeholder="Scope, theme, or anything worth noting about this release."
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
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {RELEASE_STATUS_LABELS[current.status]}
                </Badge>
                {dates ? <span>{dates}</span> : <span>No dates set</span>}
                <span>
                  · {current.itemCount} item{current.itemCount === 1 ? "" : "s"}
                </span>
              </div>
              {current.notes ? (
                <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                  <ReactMarkdown>{current.notes}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No notes yet.</p>
              )}
            </>
          )}
        </div>

        {isAdmin && !editing ? (
          <div className="flex items-center gap-2 border-t px-5 py-3">
            {shipped ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setStatus("planned", undefined, `${current.name} reopened`)
                }
                disabled={pending}
              >
                Reopen
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  setStatus(
                    "shipped",
                    `Mark "${current.name}" as released? It moves to Shipped releases and leaves the active roadmap.`,
                    `${current.name} released`,
                  )
                }
                disabled={pending}
              >
                Release
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={startEdit}
              disabled={pending}
            >
              Edit
            </Button>
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
            >
              Delete
            </button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
