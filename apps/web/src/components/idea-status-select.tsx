"use client";

import { ChevronDown } from "lucide-react";

import { ideaStatusLabel, type IdeaStage } from "@specboards/core";
import { ideaStageColors } from "@specboards/ui";

import { cn } from "@/lib/utils";

/**
 * Status-dot color (a hex value) for an idea stage key, from the shared
 * `ideaStageColors` token map; custom stages fall back to a neutral gray.
 * Render as a decorative, label-paired swatch via inline `background-color`.
 */
function ideaDotColor(status: string): string {
  return ideaStageColors[status]?.dot ?? "#a1a1aa";
}

/**
 * The idea's review stage as an editable, low-chrome control: a colored status
 * dot, the stage label, and a chevron. Deliberately styled as a *field* (a
 * ghost pill, not a bordered box) so it reads as distinct from action buttons
 * like Promote, which previously looked identical. Renders a static pill when
 * the viewer can't edit.
 */
export function IdeaStatusSelect({
  status,
  stages,
  canEdit,
  disabled,
  onChange,
  onClick,
  className,
  ariaLabel,
}: {
  status: string;
  stages: readonly IdeaStage[];
  canEdit: boolean;
  disabled?: boolean;
  onChange: (status: string) => void;
  /** Forwarded to the control so a parent row-click handler can be suppressed. */
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const dot = (
    <span
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: ideaDotColor(status) }}
    />
  );

  if (!canEdit) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground",
          className,
        )}
      >
        {dot}
        {ideaStatusLabel(status, stages)}
      </span>
    );
  }

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <span className="pointer-events-none absolute left-2.5 z-10">{dot}</span>
      <select
        value={status}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        // The dot and chevron are pointer-events-none, so every click lands on
        // the select. Attaching the parent's click interceptor here (rather than
        // a non-interactive wrapper div) keeps the stop-propagation behavior
        // without a static element handling click events.
        onClick={onClick}
        aria-label={ariaLabel}
        className="h-7 cursor-pointer appearance-none rounded-full bg-muted pl-6 pr-7 text-xs font-medium text-foreground/90 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {stages.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground" />
    </div>
  );
}
