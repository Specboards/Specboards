"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCollapsedSection } from "@/lib/use-collapsed-section";

const STORAGE_KEY = "specboard:item-detail:sections";
const OPEN_EVENT = "specboard:item-detail:open-section";

/**
 * Expand a section and scroll to it, from anywhere on the page.
 *
 * Copy elsewhere on the detail view points at controls that live inside these
 * sections ("break it down into one"), and a collapsed section makes that
 * sentence name something the reader cannot see. An event rather than shared
 * state because the pointing copy and the section are in different subtrees and
 * have no reason to know about each other otherwise.
 */
export function openDetailSection(id: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
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
  const [collapsed, setCollapsed] = useCollapsedSection(
    STORAGE_KEY,
    id,
    defaultCollapsed,
  );
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    function onOpen(event: Event) {
      if ((event as CustomEvent<string>).detail !== id) return;
      // Persisted, not just opened: the reader was sent here deliberately, so
      // treat it as the same explicit choice a click on the header would be.
      setCollapsed(false);
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [id, setCollapsed]);

  function toggle() {
    setCollapsed(!collapsed);
  }

  return (
    <section ref={ref} className="overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium",
          collapsed ? "" : "border-b bg-muted",
        )}
      >
        {title}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            collapsed ? "-rotate-90" : "",
          )}
        />
      </button>
      {collapsed ? null : <div className="px-4 py-4">{children}</div>}
    </section>
  );
}
