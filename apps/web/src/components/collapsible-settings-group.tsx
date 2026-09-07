"use client";

import { type ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCollapsedSection } from "@/lib/use-collapsed-section";

const STORAGE_KEY = "specboard:settings:sections";

/**
 * A titled, bordered settings panel whose body collapses. The header keeps the
 * title and description visible even when collapsed, so a new user can scan all
 * of a settings page's sections at a glance and expand only the one they need.
 * Collapsed state persists per section id in localStorage; `defaultCollapsed`
 * applies only until the user first toggles it. Rendered with the default on
 * the server and reconciled after mount to avoid an SSR mismatch.
 */
export function CollapsibleSettingsGroup({
  id,
  title,
  description,
  defaultCollapsed = false,
  children,
}: {
  /** Stable storage id (e.g. "workflow"). */
  id: string;
  title: string;
  description: string;
  /** Collapsed state before the user has an explicit preference. */
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useCollapsedSection(
    STORAGE_KEY,
    id,
    defaultCollapsed,
  );

  function toggle() {
    setCollapsed(!collapsed);
  }

  return (
    <section className="rounded-md border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className={cn(
          "flex w-full items-start justify-between gap-3 px-5 py-4 text-left",
          collapsed ? "" : "border-b",
        )}
      >
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        <ChevronDown
          className={cn(
            "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
            collapsed ? "-rotate-90" : "",
          )}
        />
      </button>
      {collapsed ? null : <div className="space-y-8 p-5">{children}</div>}
    </section>
  );
}
