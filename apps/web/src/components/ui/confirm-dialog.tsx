"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A centered confirmation for a destructive action, gated on typing a phrase.
 *
 * `window.confirm` is what the rest of the app reaches for, and it is the right
 * size for an action you can undo by doing the opposite. It is the wrong size
 * for one that rewrites rows the user cannot see from here: the dialog is
 * dismissed by the same Enter keypress that has been submitting forms all
 * session, and it cannot show what is about to happen.
 *
 * So this asks for the phrase back. The friction is the point, and so is the
 * space: the body is free to spell out the blast radius (how many items, which
 * tags) instead of compressing it into one line of browser chrome.
 *
 * Matching is case-insensitive and ignores surrounding whitespace. Requiring
 * exact case would turn a deliberate safeguard into a puzzle about whether the
 * tag was `SF` or `sf`, and it is the typing that carries the intent, not the
 * shift key.
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line under the title, before the detail in `children`. */
  description?: ReactNode;
  /** What the user must type back. */
  phrase: string;
  /** Overrides the "Type X to confirm" prompt when the phrase needs naming. */
  phraseLabel?: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border bg-background p-5 shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          {/* The typed phrase lives one component down so it is unmounted with
              the portal. Reopening therefore starts empty without an effect
              watching `open` to clear it, and a dialog that reopened still
              holding a matching phrase would be a confirmation that confirms
              nothing. */}
          <ConfirmForm {...props} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ConfirmForm({
  title,
  description,
  phrase,
  phraseLabel,
  confirmLabel,
  pending = false,
  onConfirm,
  children,
}: {
  title: string;
  description?: ReactNode;
  phrase: string;
  phraseLabel?: ReactNode;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();

  const matches =
    typed.trim().replace(/\s+/g, " ").toLowerCase() ===
    phrase.trim().replace(/\s+/g, " ").toLowerCase();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!matches || pending) return;
        onConfirm();
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <DialogPrimitive.Title className="text-base font-semibold">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="text-sm text-muted-foreground">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>

      {children}

      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-xs font-medium">
          {phraseLabel ?? (
            <>
              Type <code className="rounded bg-muted px-1">{phrase}</code> to
              confirm
            </>
          )}
        </label>
        <Input
          id={inputId}
          autoFocus
          value={typed}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          className="h-8"
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <DialogPrimitive.Close asChild>
          <Button type="button" size="sm" variant="ghost">
            Cancel
          </Button>
        </DialogPrimitive.Close>
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={!matches || pending}
        >
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </form>
  );
}
