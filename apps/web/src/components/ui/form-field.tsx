"use client";

import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

type FormFieldProps = {
  /** Visible label text. Associated to the control via htmlFor/id. */
  label: ReactNode;
  /** The single form control (Input, Select, Textarea, or a native one). */
  children: ReactElement;
  /** Helper text under the control, associated via aria-describedby. */
  hint?: ReactNode;
  /**
   * Validation message. When set, the control gets aria-invalid and is described
   * by the error text; the message is announced politely as it appears.
   */
  error?: ReactNode;
  /** Inline content on the label row (e.g. a "Forgot password?" link). */
  labelAside?: ReactNode;
  className?: string;
};

/**
 * Labelled form control with programmatic error and hint association (WCAG 1.3.1,
 * 3.3.1, 3.3.3, 4.1.3). It owns a single generated id and threads it onto the
 * child control as `id`, wires `aria-describedby` to the hint and error text, and
 * sets `aria-invalid` only while an error is present. The error slot is an
 * `aria-live="polite"` region (not `role="alert"`) since a persistent inline
 * validation message should be announced without interrupting the user.
 *
 * Pass exactly one control as the child. Its own `id`/`aria-describedby` props,
 * if any, are overridden.
 */
export function FormField({
  label,
  children,
  hint,
  error,
  labelAside,
  className,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {labelAside}
      </div>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} aria-live="polite" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Form-level status message shown after a submit attempt (e.g. "Passwords don't
 * match", a server error). `role="alert"` announces it assertively when it
 * appears, which is appropriate for an error that follows an explicit action.
 * Renders nothing when there is no message, so it can sit unconditionally in a
 * form's markup.
 */
export function FormError({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-xs text-destructive", className)}>
      {children}
    </p>
  );
}
