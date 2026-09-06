import {
  TagError,
  TAG_IMPORT_MAX_BYTES,
  normalizeTagName,
  planTagImport,
  resolveTagNames,
  tagKey,
  tagNameError,
  type TagDef,
  type TagImportPlan,
  type TagImportWrite,
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

/**
 * Delete a tag and take it off every item that carried it. Returns how many
 * items changed, so the caller can say what it actually did.
 */
export async function deleteTag(
  id: string,
  scope?: WorkspaceScope,
): Promise<number> {
  const store = await getStore();
  return store.deleteTag(id, scope);
}


/** What a bulk operation did to one tag. */
interface TagBulkOutcome {
  id: string;
  ok: boolean;
  /** Items this tag was taken off. Absent when the delete failed. */
  itemCount?: number;
  error?: string;
}

interface TagBulkResult {
  okCount: number;
  failCount: number;
  results: TagBulkOutcome[];
}

/*
 * There is deliberately no workspace-wide "items changed" total here. Each tag
 * is deleted in its own transaction and reports its own count, and summing
 * those would double-count an item that carried two of the selected tags --
 * the normal case in a bulk tidy-up, and the one where an inflated number
 * would be most alarming. The per-tag counts are exact, the confirmation shows
 * them before the run, and that is where the number belongs.
 */

/**
 * Delete several tag definitions at once.
 *
 * Each id is deleted on its own and reported on its own, the same bargain
 * `/api/v1/features/bulk` makes: one id that no longer exists (someone else
 * deleted it while this list was on screen) must not throw away the other
 * nineteen deletions the admin asked for.
 *
 * Like the single delete, this cascades: each tag comes off every item that
 * carried it. That is the behaviour the confirmation in front of it is sized
 * for, and the two paths must not differ -- a bulk action that was quietly
 * gentler than the single one would be its own trap.
 */
export async function deleteTags(
  ids: readonly string[],
  scope?: WorkspaceScope,
): Promise<TagBulkResult> {
  const store = await getStore();
  const results: TagBulkOutcome[] = [];
  // De-duplicated, because the second delete of an id would report "Unknown
  // tag" for work that in fact succeeded.
  for (const id of [...new Set(ids)]) {
    try {
      const itemCount = await store.deleteTag(id, scope);
      results.push({ id, ok: true, itemCount });
    } catch (err) {
      results.push({
        id,
        ok: false,
        error: err instanceof Error ? err.message : "Delete failed.",
      });
    }
  }
  return {
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    results,
  };
}

/** A planned import, plus what happened when it ran. */
interface TagImportResult {
  plan: TagImportPlan;
  /** Null on a preview; per-action outcomes once applied. */
  applied: { line: number; ok: boolean; error?: string }[] | null;
}

/**
 * Plan a CSV against the live registry, and optionally run it.
 *
 * Planning happens here rather than being trusted from the client even when the
 * client has already previewed, so the file is always measured against the
 * registry as it is at the moment of writing. A tag someone else added in
 * between changes the plan (a create becomes a no-op, a rename becomes a merge)
 * instead of failing halfway through.
 *
 * Actions run in file order, and each is committed on its own. That ordering is
 * load-bearing: a file may create `Salesforce` on one line and merge `sfdc`
 * into it on the next, which only works if the first line has landed and ids
 * are resolved by name as we go.
 */
export async function importTags(
  csv: string,
  apply: boolean,
  scope?: WorkspaceScope,
): Promise<TagImportResult> {
  if (Buffer.byteLength(csv, "utf8") > TAG_IMPORT_MAX_BYTES) {
    throw new InvalidPatchError(
      `That file is too large. Uploads are limited to ${Math.round(TAG_IMPORT_MAX_BYTES / 1024)} KB.`,
    );
  }

  const store = await getStore();
  const registry = await store.listTags(scope);
  const plan = planTagImport(csv, registry);
  if (!apply) return { plan, applied: null };

  const applied: { line: number; ok: boolean; error?: string }[] = [];
  // Names are resolved against this map as the run proceeds, so each action
  // sees the effect of the ones before it.
  let byKey = new Map(registry.map((t) => [tagKey(t.name), t]));

  for (const action of plan.actions) {
    if (action.kind === "unchanged" || action.kind === "error") continue;
    try {
      byKey = await runImportAction(store, action, byKey, scope);
      applied.push({ line: action.line, ok: true });
    } catch (err) {
      applied.push({
        line: action.line,
        ok: false,
        error: err instanceof Error ? err.message : "Failed.",
      });
    }
  }

  return { plan, applied };
}

/**
 * Execute one planned action and return the registry index it leaves behind.
 *
 * The index is updated from what each write returns rather than by re-listing
 * the registry, so a thousand-row file costs a thousand writes and not a
 * thousand extra reads. `ensureTags` hands back the whole registry anyway;
 * rename and merge each hand back the surviving definition, which is all the
 * two keys that changed need.
 */
async function runImportAction(
  store: FeatureStore,
  action: TagImportWrite,
  byKey: Map<string, TagDef>,
  scope?: WorkspaceScope,
): Promise<Map<string, TagDef>> {
  const next = new Map(byKey);

  if (action.kind === "create") {
    const registry = await store.ensureTags([action.name], scope);
    return new Map(registry.map((t) => [tagKey(t.name), t]));
  }

  const source = next.get(tagKey(action.from));
  if (!source) throw new TagError(`No tag named "${action.from}".`);

  if (action.kind === "rename") {
    const renamed = await store.renameTag(source.id, action.to, scope);
    next.delete(tagKey(action.from));
    next.set(tagKey(renamed.name), renamed);
    return next;
  }

  const target = next.get(tagKey(action.to));
  if (!target) throw new TagError(`No tag named "${action.to}".`);
  await store.mergeTags(source.id, target.id, scope);
  // The source is gone; the target keeps its key and its row.
  next.delete(tagKey(action.from));
  return next;
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
 * Building the list from the items in view (what the filter bars did before the
 * registry) means a tag nobody has used yet is invisible, and a tag scrolls out
 * of the menu the moment a filter narrows the set. So the registry leads.
 *
 * The stray half used to carry most of the weight, because deleting a tag left
 * its values on items and those values still needed filtering. Deleting now
 * takes the tag off the items too, so that source of strays is gone. What is
 * left is data the registry never saw: rows written before the registry
 * existed, and anything that reached `features.tags` without going through
 * `resolveTags`. Those are rarer, still real, and still unfilterable if this
 * drops them, so the second half stays.
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
