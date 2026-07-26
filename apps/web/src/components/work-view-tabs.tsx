"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { useOrgProductPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";

const VIEWS = [
  { view: "board", label: "Board" },
  { view: "list", label: "List" },
] as const;

/**
 * View switcher for the Backlog area. Board (kanban) and List (table) are two
 * views of the same features, selected by `?view=board|list` (default
 * `board`); this toggle flips between them without leaving `/backlog`. See
 * ADR 0001 (D6).
 */
export function WorkViewTabs() {
  const backlog = useOrgProductPath()("/backlog");
  const params = useSearchParams();
  const active = params.get("view") === "list" ? "list" : "board";

  /** Flip the `view` param, keeping the rest of the query (level, filters,
   * sort) so the two views show the same slice of the backlog. */
  function hrefFor(view: string): string {
    const next = new URLSearchParams(params.toString());
    // `board` is the default, so it needs no param of its own.
    if (view === "board") next.delete("view");
    else next.set("view", view);
    const query = next.toString();
    return query ? `${backlog}?${query}` : backlog;
  }

  return (
    <div className="inline-flex items-center rounded-md border bg-background p-0.5 text-sm">
      {VIEWS.map((tab) => (
        <Link
          key={tab.view}
          href={hrefFor(tab.view)}
          className={cn(
            "rounded px-3 py-1 font-medium transition-colors",
            active === tab.view
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
