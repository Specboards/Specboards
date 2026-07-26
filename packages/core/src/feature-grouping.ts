/**
 * Feature groupings: the auto-created cards that GitHub sync homes imported
 * specs under.
 *
 * A spec's grouping key comes from its `feature:` frontmatter when set, else
 * its folder path, so specs sharing a directory share a grouping. The title is
 * derived from that key.
 *
 * These live in core (not in the sync module) because two callers need them and
 * they are pure string functions: sync creates groupings, and the store has to
 * recognise an untouched, auto-created grouping when deciding whether one that
 * has lost its last child can be pruned.
 */

/** The grouping key prefix for a `feature:` frontmatter value. */
const FEATURE_PREFIX = "feature:";
/** The grouping key prefix for a folder-derived grouping. */
const PATH_PREFIX = "path:";

/**
 * Human label for an auto-created grouping, derived from its key: the declared
 * `feature:` value, or the last segment of the folder path, with `-`/`_` runs
 * turned into spaces and each word capitalised.
 *
 * Whitespace runs collapse too. `featureSlug` cannot emit a space, so a key
 * carrying one came from a hand-authored `feature:` value or a folder name with
 * a space in it, and a space next to a hyphen used to produce a double-spaced
 * title ("Palouse Mail  Mailpit"). That is the second path into a generated
 * grouping title, distinct from `create_spec`'s slugger.
 *
 * Returns `fallbackTitle` when the key yields nothing usable (e.g. a `spec:`
 * key, which carries only a uuid).
 */
export function featureTitleFor(key: string, fallbackTitle: string): string {
  const raw = key.startsWith(FEATURE_PREFIX)
    ? key.slice(FEATURE_PREFIX.length)
    : key.startsWith(PATH_PREFIX)
      ? key.slice(key.lastIndexOf("/") + 1)
      : "";
  const cleaned = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallbackTitle;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Whether `title` still reads as the one sync would have generated for `key`,
 * i.e. nobody has renamed the grouping.
 *
 * Returns false when the title is not derivable from the key alone (a `spec:`
 * key falls back to the spec's own title, which we cannot reconstruct here).
 * That is the safe direction: an underivable title counts as "touched", so the
 * grouping is kept rather than pruned on a guess.
 */
export function isGeneratedGroupingTitle(key: string, title: string): boolean {
  const generated = featureTitleFor(key, "");
  if (!generated) return false;
  return generated === title;
}
