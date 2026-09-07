"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { StatusDot } from "@/components/status-dot";
import { cn } from "@/lib/utils";
import { useStoredValue } from "@/lib/use-stored-value";

/** One item that could not be placed on the axis. */
type UndatedItem = {
  /** Stable key and link target for the item. */
  specId: string;
  title: string;
  status: string;
  href: string;
};

const EXPANDED_PREFIX = "specboards.roadmap.undated.";

/** No stored choice reads as collapsed, which is what the server renders. */
const parseExpanded = (raw: string | null) => raw === "1";
const serializeExpanded = (expanded: boolean) => (expanded ? "1" : "0");

/**
 * The tray of items the timeline could not plot.
 *
 * These are counted rather than dropped, so the roadmap never implies coverage
 * it does not have. But the count is the part that matters day to day, and a
 * long inline run of titles below the axis read as a blob and pushed the
 * timeline itself up the page. So the header (count plus the reason they are
 * off the axis) is always visible and the titles collapse behind it, starting
 * closed and remembering the user's choice per view in localStorage.
 *
 * Expanded, the titles are a real list: one item per line, flowing into more
 * columns as the viewport allows, so they can be scanned down rather than
 * hunted through a paragraph of links.
 */
export function UndatedTray({
  items,
  description,
  stateKey,
}: {
  items: UndatedItem[];
  /** Why these items are not on the axis; differs by view and date source. */
  description: string;
  /** Identifies this scope+view, so one roadmap's choice is not another's. */
  stateKey: string;
}) {
  // Server-renders collapsed and hydration agrees, then the stored choice is in
  // place from the first client render rather than reconciled a render later.
  const [expanded, setExpanded] = useStoredValue(
    `${EXPANDED_PREFIX}${stateKey}`,
    parseExpanded,
    serializeExpanded,
    false,
  );

  if (items.length === 0) return null;

  function toggle() {
    setExpanded(!expanded);
  }

  const listId = `undated-${stateKey}`;

  return (
    <section className="rounded-md border border-dashed">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={listId}
        className="flex w-full items-start gap-2 rounded-md p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded ? "" : "-rotate-90",
          )}
          aria-hidden
        />
        <span>
          <span className="block text-xs font-medium text-muted-foreground">
            Undated ({items.length})
          </span>
          <span className="mt-0.5 block text-2xs text-muted-foreground">
            {description}
          </span>
        </span>
      </button>
      {/*
        Multi-column rather than a grid: the items are sorted, so flowing them
        down each column and then across (the phone-book order) keeps that sort
        scannable. A grid would run it across each row instead.
      */}
      {expanded ? (
        <ul
          id={listId}
          className="columns-1 gap-x-6 px-3 pb-3 pl-8 sm:columns-2 xl:columns-3 2xl:columns-4"
        >
          {items.map((item) => (
            <li
              key={item.specId}
              className="flex min-w-0 break-inside-avoid items-center gap-1.5 py-0.5"
            >
              <StatusDot status={item.status} />
              <Link
                href={item.href}
                className="truncate text-xs text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
