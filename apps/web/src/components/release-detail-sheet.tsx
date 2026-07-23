"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Box, BoxHeader } from "@/components/ui/box";
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
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
} from "@/lib/store/types";

const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/** The statuses selectable inline. Shipping/reopening runs through the footer
 * buttons (with a confirm) so it stays a deliberate action, not an autosave. */
const INLINE_STATUSES = RELEASE_STATUSES.filter((s) => s !== "shipped");

/** Borderless-until-hover control styling, matching the item property block. */
const INLINE_CONTROL =
  "h-8 border-transparent bg-transparent px-2 shadow-none hover:bg-muted focus-visible:bg-muted";

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
 * release's dates, status, item count, and Markdown notes.
 *
 * For editors the fields edit in place: click into name / status / dates / notes
 * and the change autosaves on blur, the same click-to-edit pattern as work-item
 * properties. The high-consequence transitions (ship, reopen, delete) stay as
 * explicit footer buttons with a confirm, so they can't happen by an accidental
 * click. Viewers without write access get a read-only rendering.
 */
export function ReleaseDetailSheet({
  release,
  canEdit,
  productName,
  onClose,
}: {
  /** The release to show, or null when the panel is closed. */
  release: ReleaseRecord | null;
  /** Whether the viewer may edit this release (per-product / owner-for-portfolio). */
  canEdit: boolean;
  /** The release's product name, or null for a workspace-wide portfolio release. */
  productName: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [editingNotes, setEditingNotes] = useState(false);
  // Serialize field autosaves: coalesce a change made while one is in flight.
  const inFlightRef = useRef(false);
  const queuedRef = useRef<ReleasePatch | null>(null);

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

  /** Autosave a partial patch, coalescing overlapping edits. */
  function commit(patch: ReleasePatch) {
    if (inFlightRef.current) {
      queuedRef.current = { ...(queuedRef.current ?? {}), ...patch };
      return;
    }
    inFlightRef.current = true;
    setSaveState("saving");
    void (async () => {
      try {
        await updateRelease(current.id, patch);
        setSaveState("saved");
        router.refresh();
      } catch (err) {
        if (handleAuthError(err)) return;
        setSaveState("idle");
        toast.error(err instanceof Error ? err.message : "Save failed.");
      } finally {
        inFlightRef.current = false;
        const queued = queuedRef.current;
        if (queued) {
          queuedRef.current = null;
          commit(queued);
        }
      }
    })();
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
          <span className="text-xs text-muted-foreground">
            {productName ?? "Portfolio release"}
          </span>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {canEdit ? (
            // key on the release id so switching releases reseeds the
            // uncontrolled defaults; a background refresh can't clobber a field
            // being edited because we only read values on blur/change.
            <div key={current.id} className="space-y-3">
              <Field label="Name">
                <Input
                  defaultValue={current.name}
                  className={INLINE_CONTROL}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (!name) {
                      e.target.value = current.name;
                      toast.error("Name is required.");
                      return;
                    }
                    if (name !== current.name) commit({ name });
                  }}
                />
              </Field>

              <Field label="Status">
                {shipped ? (
                  <div className="flex h-8 items-center px-2">
                    <Badge variant="outline" className="text-[10px]">
                      Shipped
                    </Badge>
                  </div>
                ) : (
                  <Select
                    defaultValue={current.status}
                    className={INLINE_CONTROL}
                    onChange={(e) =>
                      commit({ status: e.target.value as ReleaseStatus })
                    }
                  >
                    {INLINE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {RELEASE_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Start date">
                  <Input
                    type="date"
                    defaultValue={current.startDate ?? ""}
                    className={INLINE_CONTROL}
                    onChange={(e) =>
                      commit({ startDate: e.target.value || null })
                    }
                  />
                </Field>
                <Field label={shipped ? "Planned ship date" : "Ship date"}>
                  <Input
                    type="date"
                    defaultValue={current.targetDate ?? ""}
                    className={INLINE_CONTROL}
                    onChange={(e) =>
                      commit({ targetDate: e.target.value || null })
                    }
                  />
                </Field>
              </div>

              {/* Actual ship date: read-only, stamped when the release shipped.
                  The planned dates above are retained for comparison. */}
              {shipped ? (
                <Field label="Actual ship date">
                  <div className="flex h-8 items-center px-2 text-sm">
                    {current.shippedDate ?? "—"}
                  </div>
                </Field>
              ) : null}

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Notes
                </span>
                {editingNotes ? (
                  <Textarea
                    autoFocus
                    defaultValue={current.notes ?? ""}
                    rows={8}
                    placeholder="Scope, theme, or anything worth noting about this release."
                    onBlur={(e) => {
                      setEditingNotes(false);
                      const notes = e.target.value.trim() || null;
                      if (notes !== (current.notes ?? null)) commit({ notes });
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingNotes(true)}
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  >
                    {current.notes ? (
                      <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                        <ReactMarkdown>{current.notes}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Add notes…
                      </span>
                    )}
                  </button>
                )}
              </div>

              <p
                className="h-4 text-[11px] text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {saveState === "saving"
                  ? "Saving…"
                  : saveState === "saved"
                    ? "Saved"
                    : ""}
              </p>
            </div>
          ) : (
            <Box>
              <BoxHeader className="flex-wrap justify-between gap-2 text-xs font-normal text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {RELEASE_STATUS_LABELS[current.status]}
                  </Badge>
                  {shipped && current.shippedDate
                    ? `Shipped ${current.shippedDate}`
                    : dates
                      ? dates
                      : "No dates set"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Badge variant="counter">{current.itemCount}</Badge>
                  item{current.itemCount === 1 ? "" : "s"}
                </span>
              </BoxHeader>
              <div className="px-4 py-3">
                {current.notes ? (
                  <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                    <ReactMarkdown>{current.notes}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                )}
              </div>
            </Box>
          )}
        </div>

        {canEdit ? (
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
            <span className="text-xs text-muted-foreground">
              {current.itemCount} item{current.itemCount === 1 ? "" : "s"}
            </span>
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

/** A compact labeled row: muted label above an inline control. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
