"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A tabbed settings page.
 *
 * Extracted from the Integrations page when Agents became the second page that
 * needed it. The two differ only in which tabs they hold and what the tab list
 * is called, so the switcher itself is the same component twice rather than
 * two that drift.
 *
 * Panels are passed in already rendered, because the data behind them is
 * server-fetched and this only owns which one is visible. All of them stay
 * mounted and hidden rather than being unmounted, so a card's local state - a
 * freshly created key still showing its one-time secret, a half-filled form -
 * survives switching tabs and coming back.
 */
export interface SettingsTab {
  /** Deep-link key, used as `?tab=`. */
  key: string;
  label: string;
  content: ReactNode;
}

export function SettingsTabs({
  tabs,
  ariaLabel,
  initialTab,
}: {
  tabs: readonly SettingsTab[];
  ariaLabel: string;
  /** From `?tab=`; an unknown value opens the first tab rather than nothing. */
  initialTab?: string;
}) {
  const fallback = tabs[0]?.key ?? "";
  const [active, setActive] = useState<string>(
    tabs.some((t) => t.key === initialTab) ? initialTab! : fallback,
  );

  function select(key: string) {
    setActive(key);
    // Deep-link the section without a navigation or a server round-trip.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", key);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto border-b"
      >
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => select(tab.key)}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-brand font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} role="tabpanel" hidden={tab.key !== active}>
          {tab.content}
        </div>
      ))}
    </div>
  );
}
