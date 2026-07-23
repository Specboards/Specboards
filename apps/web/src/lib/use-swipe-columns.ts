"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/lib/use-media-query";

/**
 * Drives the mobile swipe-column board pattern. Attach `scrollRef` to the
 * horizontal scroll container (the `relative` element with `snap-x` and
 * `[data-board-column]` children). Returns the active column index (the nearest
 * snap point) and `scrollToColumn(i)`, which brings a column into view honoring
 * the user's reduced-motion preference.
 *
 * Layout stays CSS-driven (the snap classes on the container and columns), so
 * this only powers the header readout and the prev/next arrows. It is inert
 * until the container actually scrolls, and does nothing meaningful at desktop
 * widths where every column is visible at once.
 *
 * The container must be the columns' offset parent (hence `relative` on it), so
 * each column's `offsetLeft` is measured in the same coordinate space as
 * `scrollLeft`.
 */
export function useSwipeColumns(columnCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  const [activeColumn, setActiveColumn] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    function update() {
      frame = 0;
      if (!el) return;
      const cols = el.querySelectorAll<HTMLElement>("[data-board-column]");
      const sl = el.scrollLeft;
      let best = 0;
      let bestDist = Infinity;
      cols.forEach((c, i) => {
        const dist = Math.abs(c.offsetLeft - sl);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      setActiveColumn(best);
    }
    function onScroll() {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [columnCount]);

  const scrollToColumn = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const cols = el.querySelectorAll<HTMLElement>("[data-board-column]");
      const target = cols[Math.max(0, Math.min(index, cols.length - 1))];
      if (!target) return;
      // scrollIntoView (not scrollTo) so the column's start aligns to the
      // scroll-port start honoring scroll-padding, and agrees with the
      // `snap-start` snap points instead of fighting a re-snap. `block: nearest`
      // keeps the page from scrolling vertically.
      target.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        inline: "start",
        block: "nearest",
      });
    },
    [reduceMotion],
  );

  return { scrollRef, activeColumn, scrollToColumn };
}
