"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";
import type { WorkspaceLevel } from "@/lib/store/types";

/**
 * Switches the Board / Roadmap between hierarchy levels (e.g. Initiative →
 * Epic → Feature). The active level lives in the `?level=` query param;
 * each tab links to its level while preserving the rest of the query. Hidden
 * when the workspace has a single level (nothing to switch between).
 */
export function LevelSwitcher({
  levels,
  active,
}: {
  levels: WorkspaceLevel[];
  active: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  if (levels.length < 2) return null;

  function hrefFor(key: string): string {
    const next = new URLSearchParams(params.toString());
    next.set("level", key);
    return `${pathname}?${next.toString()}`;
  }

  return (
    <div className="inline-flex items-center rounded-md border bg-background p-0.5 text-sm">
      {levels.map((level) => {
        const isActive = level.key === active;
        return (
          <Link
            key={level.key}
            href={hrefFor(level.key)}
            scroll={false}
            className={cn(
              "rounded px-3 py-1 font-medium transition-colors",
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {pluralize(level.label)}
          </Link>
        );
      })}
    </div>
  );
}

/** Naive English pluralization for level labels (Epic → Epics, Story → Stories). */
function pluralize(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(label)) return label + "es";
  return label + "s";
}
