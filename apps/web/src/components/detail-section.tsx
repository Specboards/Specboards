"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

const STORAGE_KEY = "specboard:item-detail:sections";

/**
 * Read the per-section collapsed map. Values are explicit user choices; a
 * section with no entry falls back to its `defaultCollapsed`. (Replaces the
 * older "set of collapsed ids" scheme, which couldn't tell "no preference"
 * apart from "expanded".)
 */
function readState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeState(id: string, collapsed: boolean) {
  try {
    const map = readState();
    map[id] = collapsed;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * A titled, collapsible section of the work item detail view (Relationships /
 * Integrations …). The collapsed state persists per section id in localStorage,
 * so it survives navigation and new sessions. `defaultCollapsed` is used only
 * until the user first toggles the section. Rendered with the default on the
 * server and reconciled after mount to avoid an SSR mismatch.
 */
export function DetailSection({
  id,
  title,
  defaultCollapsed = false,
  children,
}: {
  /** Stable storage id, shared across items (e.g. "relationships"). */
  id: string;
  title: string;
  /** Collapsed state before the user has an explicit preference. */
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    const stored = readState()[id];
    setCollapsed(stored ?? defaultCollapsed);
  }, [id, defaultCollapsed]);

  function toggle() {
    setCollapsed((prev) => {
      writeState(id, !prev);
      return !prev;
    });
  }

  return (
    <section className="rounded-lg border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium"
      >
        {title}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            collapsed ? "-rotate-90" : "",
          )}
        />
      </button>
      {collapsed ? null : <div className="border-t px-4 py-4">{children}</div>}
    </section>
  );
}
