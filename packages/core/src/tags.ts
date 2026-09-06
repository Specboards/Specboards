/**
 * Workspace tag registry (Settings -> Cards).
 *
 * Tags used to be free text: `features.tags` is a `text[]` and the editor was a
 * comma-separated input, so `area:web`, `Area:Web` and `area:web ` were three
 * distinct tags that rendered as three chips and filtered separately. Nothing
 * told anyone the third was a typo.
 *
 * The registry makes one spelling of a tag the spelling. Item values stay in
 * `features.tags`, keyed by name, exactly as `custom_fields` keys by property
 * key: dropping a tag from the registry hides it rather than destroying it, and
 * re-adding it brings the values back.
 */

/** A tag as the UI consumes it. */
export interface TagDef {
  /** Row id (uuid in db mode), used to rename or delete the definition. */
  id: string;
  /** The canonical display name, and the value stored in `features.tags`. */
  name: string;
  /** Manual ordering in the picker and in settings; ascending. */
  position: number;
}

/** Longest a tag name may be. Long enough for `area:something-specific`. */
export const TAG_NAME_MAX = 64;

/** Raised when a tag can't be created, renamed or deleted. */
export class TagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagError";
  }
}

/**
 * Tidy one tag name for storage: trim, and collapse internal runs of
 * whitespace to a single space.
 *
 * Casing is deliberately preserved. `Area:Web` and `area:web` must resolve to
 * the same tag, but which of the two the workspace *displays* is a choice its
 * members made, and lower-casing everything on the way in would take that
 * choice away to solve a matching problem that `tagKey` already solves.
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * The value two names are compared on. Case-insensitive, so `Area:Web` finds
 * the existing `area:web` instead of creating a sibling beside it.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: this key is also what the
 * database's unique index is built on, and a locale-sensitive fold would let
 * the app and Postgres disagree about whether two names collide.
 */
export function tagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/** Whether a name is usable as a tag, with the reason when it is not. */
export function tagNameError(name: string): string | null {
  const value = normalizeTagName(name);
  if (value === "") return "Tag name is required.";
  if (value.length > TAG_NAME_MAX) {
    return `Tag names are limited to ${TAG_NAME_MAX} characters.`;
  }
  if (value.includes(",")) {
    // Commas were the separator in the old free-text editor, so a name
    // containing one would split into two tags anywhere that format survives
    // (imported spec frontmatter, an old bookmark, a hand-written API call).
    return "Tag names cannot contain commas.";
  }
  return null;
}

/**
 * Resolve the tags an item is being given against the registry.
 *
 * Returns the canonical names to store and the names that have no registry row
 * yet, which the caller creates before writing. Adding a tag from a card is a
 * stated requirement, so an unknown name is a tag to create, never an error:
 * refusing it would break every agent that writes tags through the API or MCP
 * to enforce tidiness the user did not ask for.
 *
 * Order is the order the caller gave, so an item's tags stay where its author
 * put them. Duplicates that differ only by case or spacing collapse to one,
 * which is the entire point.
 */
export function resolveTagNames(
  requested: readonly string[],
  registry: readonly Pick<TagDef, "name">[],
): { names: string[]; missing: string[] } {
  const known = new Map(registry.map((t) => [tagKey(t.name), t.name]));
  const names: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const value = normalizeTagName(raw);
    if (value === "") continue;
    const key = tagKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    const canonical = known.get(key);
    if (canonical) {
      names.push(canonical);
    } else {
      names.push(value);
      missing.push(value);
    }
  }
  return { names, missing };
}
