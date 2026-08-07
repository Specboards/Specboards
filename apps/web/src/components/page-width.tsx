import type { ReactNode } from "react";

/**
 * Opt a page out of the shell's reading-width cap so it fills the viewport.
 *
 * Most pages are prose or forms, where a measure of roughly 1150px keeps lines
 * readable, so the shell in `app/layout.tsx` caps itself at `max-w-6xl`. Board,
 * table, and timeline surfaces are the opposite: every extra pixel is another
 * kanban column, table row width, or month on the axis, and the cap was just
 * empty gutters on a large monitor.
 *
 * The shell watches for this marker with `:has()`, so the opt-in travels with
 * the page rather than the layout needing to know every route. The wrapper is
 * `display: contents`, so it adds a node to the DOM but no box to the layout
 * and cannot disturb the page it wraps. Where `:has()` is unsupported the page
 * simply stays capped, which is today's behaviour.
 */
export function WidePage({ children }: { children: ReactNode }) {
  return (
    <div {...widePage} className="contents">
      {children}
    </div>
  );
}

/**
 * The same opt-in as a prop spread, for a page that already renders its own
 * root element: `<section {...widePage} className="space-y-4">`. Tagging what
 * is there beats wrapping it in a node whose only job is to carry the marker.
 */
export const widePage = { "data-page-width": "wide" } as const;
