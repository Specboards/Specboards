"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

import type { PropertyDef } from "@specboards/core";

import {
  CustomFieldInput,
  collectCustomFields,
} from "@/components/item-properties";
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
import { RELEASE_STATUS_LABELS } from "@/lib/release-status";
import {
  RELEASE_STATUSES,
  type CustomFieldValue,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
} from "@/lib/store/types";
import type { WorkspaceMember } from "@/lib/workspace";

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
  properties,
  members,
  onClose,
}: {
  /** The release to show, or null when the panel is closed. */
  release: ReleaseRecord | null;
  /** Whether the viewer may edit this release (per-product / owner-for-portfolio). */
  canEdit: boolean;
  /** The release's product name, or null for a workspace-wide portfolio release. */
  productName: string | null;
  /** Release-scoped custom-property definitions. */
  properties: PropertyDef[];
  /** Workspace members, for `user`-typed custom fields. */
  members: WorkspaceMember[];
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
  // The ship-date field, so a start date moved past it can pull it along.
  const targetDateRef = useRef<HTMLInputElement | null>(null);

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
                    <Badge variant="outline" size="sm">
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
                    onChange={(e) => {
                      const startDate = e.target.value || null;
                      // Moving the start past the ship date takes the ship date
                      // with it (the service holds the same rule for the API and
                      // MCP). Mirrored into the field here because it is
                      // uncontrolled: a refresh alone would leave the user
                      // looking at the date that no longer applies.
                      const target = targetDateRef.current;
                      const targetDate = target?.value || null;
                      if (startDate && targetDate && targetDate < startDate) {
                        if (target) target.value = startDate;
                        commit({ startDate, targetDate: startDate });
                        return;
                      }
                      commit({ startDate });
                    }}
                  />
                </Field>
                <Field label={shipped ? "Planned ship date" : "Ship date"}>
                  <Input
                    ref={targetDateRef}
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
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

              <ReleaseNotesSection release={current} canEdit onCommit={commit} />

              <ReleaseCustomFields
                release={current}
                properties={properties}
                members={members}
                canEdit
                onCommit={commit}
              />

              <p
                className="h-4 text-2xs text-muted-foreground"
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
            <div className="space-y-4">
              <Box>
                <BoxHeader className="flex-wrap justify-between gap-2 text-xs font-normal text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" size="sm">
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
              <ReleaseNotesSection
                release={current}
                canEdit={false}
                onCommit={() => {}}
              />
              <ReleaseCustomFields
                release={current}
                properties={properties}
                members={members}
                canEdit={false}
                onCommit={() => {}}
              />
            </div>
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

/** The URL's host, for a compact link label; falls back to the raw URL. */
function externalHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The customer-facing release notes, distinct from the internal planning notes
 * above. A release can carry in-app Markdown notes, a link to externally hosted
 * notes, or neither. Following the "Add starts as an affordance" convention, an
 * empty release shows "Write release notes" / "Link external notes" controls;
 * the editor fields appear only after the user opts in, and Cancel collapses
 * them without saving. Saving an empty body/URL resets the mode to `none`.
 * Viewers (canEdit=false) get a read-only rendering.
 */
function ReleaseNotesSection({
  release,
  canEdit,
  onCommit,
}: {
  release: ReleaseRecord;
  canEdit: boolean;
  onCommit: (patch: ReleasePatch) => void;
}) {
  // Which editor is open, or null when showing the collapsed/read view.
  const [draftKind, setDraftKind] = useState<"in_app" | "external" | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const mode = release.releaseNotesMode;

  function saveInApp() {
    const value = bodyRef.current?.value.trim() ?? "";
    onCommit({
      releaseNotesMode: value ? "in_app" : "none",
      releaseNotesBody: value || null,
    });
    setDraftKind(null);
  }

  function saveExternal() {
    const value = urlRef.current?.value.trim() ?? "";
    onCommit({
      releaseNotesMode: value ? "external" : "none",
      releaseNotesUrl: value || null,
    });
    setDraftKind(null);
  }

  function remove() {
    onCommit({ releaseNotesMode: "none" });
    setDraftKind(null);
  }

  // Save the in-app Markdown notes to a .md file on the user's machine.
  function downloadNotes() {
    const body = release.releaseNotesBody;
    if (!body) return;
    const slug =
      release.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "release";
    const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${slug}-release-notes.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const header = (
    <span className="text-xs font-medium text-muted-foreground">
      Release notes
    </span>
  );

  // Editor: revealed once the user opts into Write or Link external.
  if (canEdit && draftKind) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          {header}
          <div className="flex gap-1">
            <ModeTab
              active={draftKind === "in_app"}
              onClick={() => setDraftKind("in_app")}
            >
              Write
            </ModeTab>
            <ModeTab
              active={draftKind === "external"}
              onClick={() => setDraftKind("external")}
            >
              Link external
            </ModeTab>
          </div>
        </div>

        {draftKind === "in_app" ? (
          <Textarea
            ref={bodyRef}
            autoFocus
            defaultValue={release.releaseNotesBody ?? ""}
            rows={8}
            placeholder="Customer-facing release notes (Markdown)."
          />
        ) : (
          <Input
            ref={urlRef}
            autoFocus
            type="url"
            defaultValue={release.releaseNotesUrl ?? ""}
            placeholder="https://example.com/release-notes"
          />
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={draftKind === "in_app" ? saveInApp : saveExternal}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraftKind(null)}
          >
            Cancel
          </Button>
          {mode !== "none" ? (
            <Button
              variant="link"
              size="inline"
              onClick={remove}
              className="ml-auto text-xs font-normal text-muted-foreground hover:text-destructive"
            >
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // Collapsed / read view.
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        {header}
        <div className="flex items-center gap-3">
          {mode === "in_app" && release.releaseNotesBody ? (
            <button
              type="button"
              onClick={downloadNotes}
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Download
            </button>
          ) : null}
          {canEdit && mode !== "none" ? (
            <button
              type="button"
              onClick={() =>
                setDraftKind(mode === "external" ? "external" : "in_app")
              }
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Edit
            </button>
          ) : null}
        </div>
      </div>

      {mode === "in_app" && release.releaseNotesBody ? (
        <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
          <ReactMarkdown>{release.releaseNotesBody}</ReactMarkdown>
        </div>
      ) : mode === "external" && release.releaseNotesUrl ? (
        <a
          href={release.releaseNotesUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
        >
          {externalHost(release.releaseNotesUrl)}
          <span aria-hidden>↗</span>
        </a>
      ) : canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraftKind("in_app")}
          >
            Write release notes
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraftKind("external")}
          >
            Link external notes
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No release notes.</p>
      )}
    </div>
  );
}

/** Format a release custom-field value for the read-only view. */
function formatCustomValue(
  property: PropertyDef,
  value: CustomFieldValue,
  members: WorkspaceMember[],
): string {
  if (value === null || value === undefined || value === "") return "";
  if (property.type === "user") {
    return members.find((m) => m.userId === value)?.name ?? String(value);
  }
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Release-scoped custom properties (defined in Settings -> Cards with the
 * "Releases" scope), the release-side parity of an item's custom fields. For
 * editors the values edit in a small form and save together; the whole map is
 * sent on save (mirrors item custom fields). Viewers see a read-only list.
 * Renders nothing when the workspace has no release-scoped properties.
 */
function ReleaseCustomFields({
  release,
  properties,
  members,
  canEdit,
  onCommit,
}: {
  release: ReleaseRecord;
  properties: PropertyDef[];
  members: WorkspaceMember[];
  canEdit: boolean;
  onCommit: (patch: ReleasePatch) => void;
}) {
  if (properties.length === 0) return null;
  const values = release.customFields ?? {};

  if (!canEdit) {
    return (
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Details
        </span>
        <dl className="space-y-1">
          {properties.map((property) => (
            <div key={property.key} className="flex gap-2 text-sm">
              <dt className="w-32 shrink-0 text-muted-foreground">
                {property.label}
              </dt>
              <dd className="min-w-0 flex-1">
                {formatCustomValue(
                  property,
                  values[property.key] ?? null,
                  members,
                ) || "—"}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onCommit({ customFields: collectCustomFields(properties, data, values) });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <span className="text-xs font-medium text-muted-foreground">Details</span>
      <div className="space-y-2">
        {properties.map((property) => (
          <label
            key={property.key}
            className="grid grid-cols-[8rem_1fr] items-center gap-2"
          >
            <span className="truncate text-xs text-muted-foreground">
              {property.label}
            </span>
            <CustomFieldInput
              property={property}
              value={values[property.key] ?? null}
              members={members}
            />
          </label>
        ))}
      </div>
      <Button type="submit" size="sm" variant="outline">
        Save details
      </Button>
    </form>
  );
}

/** A small segmented-control tab for switching between Write / Link external. */
function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-md px-2 py-0.5 text-2xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
        (active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
