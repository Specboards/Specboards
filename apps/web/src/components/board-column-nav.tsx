"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * Mobile-only header for the swipe-column boards: the current column's label, an
 * "n of m" position, and prev/next arrows. Hidden from `md` up, where every
 * column is on screen at once. It is a control surface over `useSwipeColumns`
 * and renders nothing structural. Arrows are 36px targets (SC 2.5.8) and carry
 * text alternatives (SC 4.1.2); the position readout is plain text, not
 * color-coded (SC 1.4.1).
 */
export function BoardColumnNav({
  label,
  index,
  count,
  onPrev,
  onNext,
}: {
  label: ReactNode;
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-3 flex items-center justify-between gap-2 md:hidden">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Previous column"
        onClick={onPrev}
        disabled={index <= 0}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </Button>
      <div className="min-w-0 text-center">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">
          {index + 1} of {count}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Next column"
        onClick={onNext}
        disabled={index >= count - 1}
      >
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
