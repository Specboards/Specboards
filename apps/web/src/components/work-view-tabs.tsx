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
  const active = useSearchParams().get("view") === "list" ? "list" : "board";
  return (
    <div className="inline-flex items-center rounded-md border bg-background p-0.5 text-sm">
      {VIEWS.map((tab) => (
        <Link
          key={tab.view}
          // `board` is the default, so it needs no query param.
          href={tab.view === "board" ? backlog : `${backlog}?view=list`}
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
