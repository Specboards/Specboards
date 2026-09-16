import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MOVED_TO_AGENTS, movedAgentsTab } from "@/lib/settings-tabs-moved";

/**
 * The forward from an old Integrations tab to its new home under Agents.
 *
 * The mapping is only worth having if it names tabs that exist. A destination
 * that no longer matches a tab key sends a bookmark to the Agents page's first
 * tab and says nothing about it, which is the failure mode this whole module
 * was written to avoid, so the page's own source is the fixture here rather
 * than a second list that would drift the same way.
 */

const AGENTS_PAGE = join(
  __dirname,
  "..",
  "app",
  "[org]",
  "settings",
  "agents",
  "page.tsx",
);

/** The `key:` of every tab the Agents page builds. */
function agentsTabKeys(): string[] {
  const source = readFileSync(AGENTS_PAGE, "utf8");
  return [...source.matchAll(/^\s+key: "([a-z-]+)",$/gm)].map((m) => m[1]!);
}

describe("tabs that moved from Integrations to Agents", () => {
  it("sends every moved tab to a tab the Agents page actually renders", () => {
    const keys = agentsTabKeys();
    // Guard the guard: a parse that silently found nothing would pass every
    // assertion below.
    expect(keys.length).toBeGreaterThanOrEqual(
      Object.keys(MOVED_TO_AGENTS).length,
    );
    for (const destination of Object.values(MOVED_TO_AGENTS)) {
      expect(keys).toContain(destination);
    }
  });

  it("leaves the tabs that stayed on Integrations alone", () => {
    // Repositories, API keys and webhooks are third-party surfaces and did not
    // move. Forwarding one would send somebody to a page that does not hold it.
    for (const stayed of ["repositories", "api-keys", "webhooks"]) {
      expect(movedAgentsTab(stayed)).toBeNull();
    }
  });

  it("ignores no tab at all, and a tab nobody has ever had", () => {
    expect(movedAgentsTab(undefined)).toBeNull();
    expect(movedAgentsTab("")).toBeNull();
    expect(movedAgentsTab("nonsense")).toBeNull();
  });

  it("does not inherit a destination from Object.prototype", () => {
    // `MOVED_TO_AGENTS[tab]` is an index into an object literal with a
    // caller-supplied key, and "constructor" would otherwise come back truthy
    // and be redirected to.
    expect(movedAgentsTab("constructor")).toBeNull();
    expect(movedAgentsTab("toString")).toBeNull();
    expect(movedAgentsTab("__proto__")).toBeNull();
  });

  it("renames the two tabs whose old names stopped making sense", () => {
    // "MCP" named the protocol rather than the job, and a tab called Agents
    // inside a page called Agents says nothing.
    expect(movedAgentsTab("mcp")).toBe("connections");
    expect(movedAgentsTab("agents")).toBe("identities");
  });
});
