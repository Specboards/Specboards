import {
  TagError,
  normalizeTagName,
  resolveTagNames,
  tagKey,
  tagNameError,
  type TagDef,
} from "@specboards/core";

import { InvalidPatchError } from "@/lib/service-errors";
import { getStore, type FeatureStore, type WorkspaceScope } from "@/lib/store";

/**
 * The workspace tag registry: one list deciding how each tag is spelled.
 *
 * The rule every write goes through is `resolveTags` below. It is called from
 * the two places an item's tags can be set (`applyFeaturePatch` and
 * `createWorkItem`), so the UI, the REST API, the MCP tools and spec import all
 * get the same behaviour without each having to remember to ask for it. That is
 * the whole reason this is in the service layer and not in a form handler.
 */

export async function listTags(scope?: WorkspaceScope): Promise<TagDef[]> {
  const store = await getStore();
  return store.listTags(scope);
}

/** Add one tag by name. Any member may do this; see the migration's RLS note. */
export async function createTag(
  name: string,
  scope?: WorkspaceScope,
): Promise<TagDef> {
  const value = normalizeTagName(name);
  const problem = tagNameError(value);
  if (problem) throw new InvalidPatchError(problem);
  const store = await getStore();
  const before = await store.listTags(scope);
  const after = await store.ensureTags([value], scope);
  if (after.length === before.length) {
    // ensureTags is idempotent by design, but a caller who explicitly asked to
    // create this tag should hear that it already exists rather than get a
    // success that did nothing.
    throw new TagError(`"${value}" already exists.`);
  }
  const created = after.find(
    (t) => !before.some((b) => b.id === t.id) && t.name === value,
  );
  if (!created) throw new TagError(`Could not create "${value}".`);
  return created;
}

export async function renameTag(
  id: string,
  name: string,
  scope?: WorkspaceScope,
): Promise<TagDef> {
  const store = await getStore();
  return store.renameTag(id, normalizeTagName(name), scope);
}

export async function deleteTag(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteTag(id, scope);
}

/**
 * Canonicalize the tags an item is being given, creating registry rows for any
 * name that does not exist yet.
 *
 * Two things happen here, and both are the point of the feature:
 *
 * A name that matches an existing tag case-insensitively is rewritten to that
 * tag's spelling, so `Area:Web` becomes `area:web` rather than a second tag
 * that looks the same on a card and filters separately.
 *
 * A name that matches nothing becomes a new registry row. Adding a tag from a
 * card is a stated requirement, and refusing an unknown name would break every
 * agent writing tags through the API or MCP in order to enforce a tidiness
 * nobody asked for. The registry constrains *spelling*, not vocabulary.
 *
 * `ensureTags` is only called when there is something to create, so the common
 * write (tags that all already exist) costs one read and no write.
 */
export async function resolveTags(
  store: FeatureStore,
  requested: readonly string[],
  scope?: WorkspaceScope,
): Promise<string[]> {
  for (const raw of requested) {
    const problem = tagNameError(raw);
    // An empty entry is dropped rather than rejected: a trailing comma in the
    // old editor produced exactly that, and so does an import of frontmatter
    // written by hand.
    if (problem && normalizeTagName(raw) !== "") {
      throw new InvalidPatchError(problem);
    }
  }
  const registry = await store.listTags(scope);
  const { names, missing } = resolveTagNames(requested, registry);
  if (missing.length > 0) await store.ensureTags(missing, scope);
  return names;
}

/**
 * The tag options a filter menu should offer: the registry, in its own order,
 * followed by any tag still on an item that the registry no longer lists.
 *
 * Both halves matter. Building the list from the items in view (what the
 * filter bars did before the registry) means a tag nobody has used yet is
 * invisible, and a tag scrolls out of the menu the moment a filter narrows the
 * set. Building it from the registry alone would drop the tags left behind by a
 * deleted definition, which still sit on items and still need filtering.
 *
 * Comparison is case-insensitive so a legacy `Area:Web` on an old card does not
 * appear beside the registry's `area:web`.
 */
export function mergeTagOptions(
  registry: readonly TagDef[],
  features: readonly { tags: string[] }[],
): string[] {
  const seen = new Set(registry.map((t) => tagKey(t.name)));
  const strays: string[] = [];
  for (const feature of features) {
    for (const tag of feature.tags) {
      const key = tagKey(tag);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      strays.push(tag);
    }
  }
  return [
    ...registry.map((t) => t.name),
    ...strays.sort((a, b) => a.localeCompare(b)),
  ];
}
