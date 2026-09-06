"use client";

import { useId, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A settings value that shows itself before it offers to be edited.
 *
 * The convention this implements is in CLAUDE.md ("Settings show a value; work
 * items edit one"): a configured value renders as text with an Edit control
 * beside it, and the input appears only once someone asks for it. Nobody opens
 * Settings to retype something that is already correct, so a pre-filled input
 * next to a Save button is a form asking to be completed when there was nothing
 * to complete. The opposite call is right on a work item, where the field IS the
 * thing being worked on, so do not reach for this there.
 *
 * Everything except the fields themselves is handled here, so the three or four
 * settings that use it cannot drift apart: the collapsed row, the disclosure,
 * Save/Cancel, the pending state, and the status line that outlives the
 * collapse (a change-email confirmation has to stay readable after the form has
 * gone).
 */

export type SettingStatus = { kind: "ok" | "error"; message: string } | null;

/**
 * Async result of a save. Announced when it appears: an error interrupts
 * (role=alert, assertive), a success is polite (role=status). The wording
 * carries the outcome so it never relies on color alone (SC 1.4.1).
 */
export function StatusLine({
  status,
  className,
}: {
  status: SettingStatus;
  className?: string;
}) {
  if (!status) return null;
  return (
    <p
      role={status.kind === "error" ? "alert" : "status"}
      className={cn(
        "text-xs",
        status.kind === "ok" ? "text-muted-foreground" : "text-destructive",
        className,
      )}
    >
      {status.message}
    </p>
  );
}

export function SettingRow({
  label,
  value,
  hint,
  canEdit = true,
  editLabel = "Edit",
  submitLabel = "Save",
  successMessage,
  onSave,
  children,
  className,
}: {
  /** What the value is, e.g. "Name". */
  label: string;
  /** The current value, shown while collapsed. */
  value: ReactNode;
  /** Optional explanation, shown in both states. */
  hint?: ReactNode;
  /** False renders the value with no way in (a non-owner reading a setting). */
  canEdit?: boolean;
  editLabel?: string;
  submitLabel?: string;
  /**
   * Confirmation shown after a successful save. A save that resolves with a
   * string uses that instead, for the cases where the outcome is not simply
   * "saved" (changing an email sends a link rather than applying a change).
   */
  successMessage?: string;
  /**
   * Persist the form. Throw to keep the form open with the error shown; resolve
   * to collapse back to the value. `close` is passed for the rare save that
   * wants to collapse before its own follow-up work finishes.
   */
  onSave: (
    data: FormData,
    close: () => void,
  ) => Promise<string | void> | string | void;
  /** The input(s). Rendered inside the form only while it is open. */
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SettingStatus>(null);
  const [pending, startTransition] = useTransition();
  const headingId = useId();

  function close() {
    setOpen(false);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      setStatus(null);
      try {
        const message = await onSave(data, close);
        setStatus({
          kind: "ok",
          message: message || successMessage || `${label} saved.`,
        });
        setOpen(false);
      } catch (err) {
        setStatus({
          kind: "error",
          message:
            err instanceof Error ? err.message : `Couldn't save ${label}.`,
        });
      }
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span id={headingId} className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {open ? null : (
          <>
            <span className="text-sm">{value}</span>
            {canEdit ? (
              <Button
                type="button"
                variant="link"
                size="inline"
                className="ml-auto text-xs"
                onClick={() => {
                  // Clear a stale confirmation: a second edit starting under
                  // the previous one's "saved" reads as already done.
                  setStatus(null);
                  setOpen(true);
                }}
              >
                {editLabel}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {open ? (
        <form
          onSubmit={onSubmit}
          aria-labelledby={headingId}
          className="space-y-3 rounded-md border bg-muted/20 p-3"
        >
          {children}
          <StatusLine status={status} />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setStatus(null);
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          <StatusLine status={status} />
        </>
      )}
    </div>
  );
}
