import { leafLevel, type WorkspaceLevel } from "@specboard/core";

/**
 * Resolve the active hierarchy level for a list view from the `?level=` query
 * param. Falls back to the leaf (spec-backed) level — the default view that
 * shows the git-synced work — when the param is missing or unknown.
 */
export function resolveActiveLevel(
  levels: WorkspaceLevel[],
  raw: string | string[] | undefined,
): WorkspaceLevel {
  const key = Array.isArray(raw) ? raw[0] : raw;
  return levels.find((l) => l.key === key) ?? leafLevel(levels);
}
