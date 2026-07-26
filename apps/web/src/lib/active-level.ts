import { defaultBrowseLevel, type WorkspaceLevel } from "@specboards/core";

/**
 * Resolve the active hierarchy level for a list view from the `?level=` query
 * param. Falls back to the level above the leaf (Feature in the default
 * hierarchy) — the planning altitude teams browse most — when the param is
 * missing or unknown.
 */
export function resolveActiveLevel(
  levels: WorkspaceLevel[],
  raw: string | string[] | undefined,
): WorkspaceLevel {
  const key = Array.isArray(raw) ? raw[0] : raw;
  return levels.find((l) => l.key === key) ?? defaultBrowseLevel(levels);
}

/**
 * Naive English pluralization for level labels (Epic -> Epics, Story ->
 * Stories). Shared by the level switcher and the views that title a section
 * with the active level.
 */
export function pluralizeLevelLabel(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(label)) return label + "es";
  return label + "s";
}
