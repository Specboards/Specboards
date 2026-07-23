"use client";

import { ArrowDown, ArrowUp, MoreVertical } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type MoveOption = {
  key: string;
  label: string;
  /** The item's current bucket: shown checked and not selectable. */
  current?: boolean;
  /** A destination the workflow does not allow from here. */
  disabled?: boolean;
};

/**
 * The keyboard- and single-pointer-operable alternative to dragging a card
 * (WCAG 2.1.1 Level A, 2.5.7 Dragging Movements). A kebab trigger opens a menu
 * that relocates the item to another bucket (status column, release, group) and
 * optionally nudges it up or down within the current one. Radix supplies the
 * full keyboard model; the outcome should be announced by the caller.
 *
 * Rendered on cards that are otherwise moved by drag, so its pointer events are
 * stopped from bubbling into the drag sensor on the card behind it.
 */
export function MoveMenu({
  triggerLabel,
  destinationsLabel,
  destinations,
  onSelect,
  reorder,
  className,
}: {
  /** Accessible name for the trigger, e.g. `Move "Login flow"`. */
  triggerLabel: string;
  /** Heading over the destination list, e.g. "Move to column". */
  destinationsLabel: string;
  destinations: MoveOption[];
  onSelect: (key: string) => void;
  /** Optional within-bucket reordering. Omit where order is not manual. */
  reorder?: {
    onUp: () => void;
    onDown: () => void;
    canUp: boolean;
    canDown: boolean;
  };
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={triggerLabel}
        title="Move"
        // Keep the trigger's pointer/click from reaching the card behind it,
        // which would start a drag or open the item.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <MoreVertical className="h-4 w-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{destinationsLabel}</DropdownMenuLabel>
        {destinations.map((d) => (
          <DropdownMenuCheckItem
            key={d.key}
            checked={d.current}
            disabled={d.disabled || d.current}
            onSelect={() => onSelect(d.key)}
          >
            {d.label}
          </DropdownMenuCheckItem>
        ))}
        {reorder ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!reorder.canUp}
              onSelect={() => reorder.onUp()}
            >
              <ArrowUp className="size-4" aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!reorder.canDown}
              onSelect={() => reorder.onDown()}
            >
              <ArrowDown className="size-4" aria-hidden />
              Move down
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
