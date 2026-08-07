"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { StatusDot } from "@/components/status-dot";
import { cn } from "@/lib/utils";

/** One item that could not be placed on the axis. */
export type UndatedItem = {
  /** Stable key and link target for the item. */
  specId: string;
  title: string;
  status: string;
  href: string;
};

const STORAGE_PREFIX = "specboards.roadmap.undated.";

function readExpanded(key: string): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? undefined : raw === "1";
  } catch {
    return undefined;
  }
}

function writeExpanded(key: string, expanded: boolean) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, expanded ? "1" : "0");
  } catch {
    // Persistence is best-effort.
  }
}

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
  // Server-render collapsed, then reconcile with the stored choice after mount
  // so there is no SSR mismatch.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(readExpanded(stateKey) ?? false);
  }, [stateKey]);

  if (items.length === 0) return null;

  function toggle() {
    setExpanded((prev) => {
      writeExpanded(stateKey, !prev);
      return !prev;
    });
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
