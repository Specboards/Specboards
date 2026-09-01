import { defaultBrowseLevel, type WorkspaceLevel } from "@specboards/core";

/**
 * Resolve the active hierarchy level for a list view from the `?level=` query
 * param. Falls back to the level above the leaf (Feature in the default
 * hierarchy) — the planning altitude teams browse most — when the param is
 * missing or unknown.
 *
 * `populated` narrows that fallback to a level that has something on it. An
 * explicit `?level=` always wins, so this only affects the landing case: the
 * board shows work rather than an empty column with a "create your first one"
 * prompt in front of it. A new workspace's sample data and everything
 * `pnpm db:seed` imports are leaf items, so without this the first thing a new
 * self-hosted admin saw was "No feature items yet" with four onboarding cards,
 * one of them titled "Welcome to Specboards", hidden a tab away.
 */
export function resolveActiveLevel(
  levels: WorkspaceLevel[],
  raw: string | string[] | undefined,
  populated?: Iterable<string>,
): WorkspaceLevel {
  const key = Array.isArray(raw) ? raw[0] : raw;
  const explicit = levels.find((l) => l.key === key);
  if (explicit) return explicit;

  const fallback = defaultBrowseLevel(levels);
  if (!populated) return fallback;

  const withItems = new Set(populated);
  if (withItems.size === 0 || withItems.has(fallback.key)) return fallback;

  // Nothing at the usual altitude. Prefer the closest populated level below it,
  // which is where work accumulates, before looking above.
  const at = levels.findIndex((l) => l.key === fallback.key);
  const below = levels.slice(at + 1).find((l) => withItems.has(l.key));
  if (below) return below;
  return (
    levels
      .slice(0, at)
      .reverse()
      .find((l) => withItems.has(l.key)) ?? fallback
  );
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
