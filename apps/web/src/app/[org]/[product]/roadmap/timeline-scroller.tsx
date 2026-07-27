"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** How much of the visible width one press of a pan button moves. */
const PAN_FRACTION = 0.8;

/**
 * The scrolling frame both timelines draw inside.
 *
 * A time axis is almost always wider than the page, and `overflow-x-auto` alone
 * is not a usable answer: on macOS the scrollbar is an overlay that only appears
 * mid-gesture, and on a tall timeline it sits below the fold, so a mouse user
 * has no way to reach the rest of the axis and reasonably concludes the view
 * does not scroll. This adds the affordances that make the range reachable
 * without a trackpad: pan buttons, drag-to-pan anywhere on the grid, arrow keys
 * (the region is focusable), and an initial scroll that brings today into view.
 *
 * The buttons only render when there is something to pan to, so a timeline that
 * already fits stays clean.
 */
export function TimelineScroller({
  children,
  leading,
  label,
  focusPx = null,
}: {
  children: React.ReactNode;
  /** Controls shown at the left of the toolbar row (e.g. expand/collapse all). */
  leading?: React.ReactNode;
  /** Accessible name for the scrollable region. */
  label: string;
  /**
   * Where to centre the initial scroll, in px from the left of the content.
   * Today, in practice: opening on a long history with the plan off-screen to
   * the right is the same failure as not being able to scroll at all.
   */
  focusPx?: number | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Drag origin: where the pointer went down and where the track was then.
  const dragRef = useRef<{ x: number; scrollLeft: number } | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflowing(max > 1);
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Bring the focus point (today) into view once, on mount. Skipped when the
  // whole axis already fits, and when the point is on screen anyway.
  useEffect(() => {
    const el = ref.current;
    if (!el || focusPx === null) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) return;
    // Already on screen: never yank a view the reader has panned somewhere
    // deliberate. This is also why the effect keys on `focusPx` rather than
    // running once: changing the zoom or the filter rebuilds the axis and moves
    // today to a new offset, and landing at the old scroll position is landing
    // nowhere in particular.
    if (focusPx >= el.scrollLeft && focusPx <= el.scrollLeft + el.clientWidth) {
      return;
    }
    el.scrollLeft = Math.max(0, Math.min(max, focusPx - el.clientWidth / 2));
  }, [focusPx]);

  function pan(direction: -1 | 1): void {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * PAN_FRACTION,
      behavior: "smooth",
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // Only a plain drag on the grid pans: a press on a link, a button, or a
    // disclosure has to stay a press on that control.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("a, button, input, select, textarea")) {
      return;
    }
    const el = ref.current;
    if (!el || el.scrollWidth - el.clientWidth <= 1) return;
    dragRef.current = { x: e.clientX, scrollLeft: el.scrollLeft };
    setDragging(true);
    el.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const origin = dragRef.current;
    const el = ref.current;
    if (!origin || !el) return;
    el.scrollLeft = origin.scrollLeft - (e.clientX - origin.x);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    ref.current?.releasePointerCapture(e.pointerId);
  }

  const showControls = overflowing || leading !== undefined;

  return (
    <div className="space-y-2">
      {showControls ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">{leading}</div>
          {overflowing ? (
            <div className="flex items-center gap-1">
              <PanButton
                direction="left"
                disabled={atStart}
                onClick={() => pan(-1)}
              />
              <PanButton
                direction="right"
                disabled={atEnd}
                onClick={() => pan(1)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        ref={ref}
        // Focusable so the axis is reachable with arrow keys alone, which is
        // also what makes the pan buttons non-essential rather than the only
        // way. A scrollable region has to be keyboard-operable (WCAG 2.1.1),
        // and a labelled region with tabindex="0" is how that is done; the
        // lint rule is the general case, not this one.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label={label}
        onScroll={measure}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          overflowing ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function PanButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className="sr-only">
        Scroll the timeline {direction === "left" ? "left" : "right"}
      </span>
    </button>
  );
}
