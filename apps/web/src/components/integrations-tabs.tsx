"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type TabKey = "mcp" | "api-keys" | "webhooks" | "repositories";

const TAB_KEYS: readonly TabKey[] = [
  "mcp",
  "api-keys",
  "webhooks",
  "repositories",
];

const LABELS: Record<TabKey, string> = {
  mcp: "MCP",
  "api-keys": "API keys",
  webhooks: "Webhooks",
  repositories: "Repositories",
};

/**
 * Client tab switcher for the Integrations page. The three sections are passed
 * in as already-rendered nodes (server-fetched), so this only owns which one is
 * visible. All panels stay mounted (hidden, not unmounted) so a card's local
 * state - e.g. a freshly created key still showing its one-time secret -
 * survives switching tabs. `initialTab` lets a deep link (?tab=) open a section.
 */
export function IntegrationsTabs({
  mcp,
  apiKeys,
  webhooks,
  repositories,
  initialTab,
}: {
  mcp: ReactNode;
  apiKeys: ReactNode;
  webhooks: ReactNode;
  repositories: ReactNode;
  initialTab?: string;
}) {
  const content: Record<TabKey, ReactNode> = {
    mcp,
    "api-keys": apiKeys,
    webhooks,
    repositories,
  };
  const start = TAB_KEYS.includes(initialTab as TabKey)
    ? (initialTab as TabKey)
    : "mcp";
  const [active, setActive] = useState<TabKey>(start);

  function select(key: TabKey) {
    setActive(key);
    // Deep-link the section without a navigation/server round-trip.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", key);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Integrations" className="flex gap-1 border-b">
        {TAB_KEYS.map((key) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => select(key)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                isActive
                  ? "border-brand font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {LABELS[key]}
            </button>
          );
        })}
      </div>
      {TAB_KEYS.map((key) => (
        <div key={key} role="tabpanel" hidden={key !== active}>
          {content[key]}
        </div>
      ))}
    </div>
  );
}
