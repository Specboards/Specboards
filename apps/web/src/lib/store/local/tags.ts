/**
 * The workspace tag registry, in the local (single-user, JSON file) store.
 *
 * Mirrors ./db/tags.ts. No RLS and no concurrency to worry about, so the
 * read-modify-write shape the db store deliberately avoids is fine here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  TagError,
  normalizeTagName,
  tagKey,
  tagNameError,
  type TagDef,
} from "@specboards/core";

import type { WorkspaceScope } from "../types";

import { localPath } from "./paths";
import type { LocalStoreContext } from "./context";

async function readTags(ctx: LocalStoreContext): Promise<TagDef[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "tags"), "utf8"),
    ) as TagDef[];
  } catch {
    return [];
  }
}

async function writeTags(
  ctx: LocalStoreContext,
  rows: TagDef[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "tags")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "tags"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

export async function listTags(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<TagDef[]> {
  return (await readTags(ctx)).sort((a, b) => a.position - b.position);
}

export async function ensureTags(
  ctx: LocalStoreContext,
  names: string[],
  _scope?: WorkspaceScope,
): Promise<TagDef[]> {
  const rows = await readTags(ctx);
  const known = new Set(rows.map((t) => tagKey(t.name)));
  let position = rows.reduce((m, t) => Math.max(m, t.position), -1) + 1;
  let added = false;
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (name === "") continue;
    const problem = tagNameError(name);
    if (problem) throw new TagError(problem);
    const key = tagKey(name);
    if (known.has(key)) continue;
    known.add(key);
    rows.push({ id: randomUUID(), name, position: position++ });
    added = true;
  }
  if (added) await writeTags(ctx, rows);
  return [...rows].sort((a, b) => a.position - b.position);
}

export async function renameTag(
  ctx: LocalStoreContext,
  id: string,
  name: string,
  _scope?: WorkspaceScope,
): Promise<TagDef> {
  const next = normalizeTagName(name);
  const problem = tagNameError(next);
  if (problem) throw new TagError(problem);

  const rows = await readTags(ctx);
  const tag = rows.find((t) => t.id === id);
  if (!tag) throw new TagError(`Unknown tag: ${id}`);
  const clash = rows.find(
    (t) => t.id !== id && tagKey(t.name) === tagKey(next),
  );
  if (clash) {
    throw new TagError(
      `"${clash.name}" already exists. Rename this tag to something else, or merge the two with a bulk upload.`,
    );
  }
  const previous = tag.name;
  if (previous === next) return tag;
  tag.name = next;
  await writeTags(ctx, rows);
  await renameOnItems(ctx, previous, next);
  return tag;
}

/**
 * Fold one tag into another. Mirrors ./db/tags.ts: items carrying the source
 * carry the target instead, de-duplicated in place, and the source definition
 * goes away.
 */
export async function mergeTags(
  ctx: LocalStoreContext,
  sourceId: string,
  targetId: string,
  _scope?: WorkspaceScope,
): Promise<TagDef> {
  if (sourceId === targetId) {
    throw new TagError("A tag cannot be merged into itself.");
  }
  const rows = await readTags(ctx);
  const source = rows.find((t) => t.id === sourceId);
  if (!source) throw new TagError(`Unknown tag: ${sourceId}`);
  const target = rows.find((t) => t.id === targetId);
  if (!target) throw new TagError(`Unknown tag: ${targetId}`);

  await writeTags(
    ctx,
    rows.filter((t) => t.id !== sourceId),
  );
  await renameOnItems(ctx, source.name, target.name);
  return target;
}

/**
 * Delete a tag: take it off every item that carries it, then drop the
 * definition. Returns how many items were changed. Mirrors ./db/tags.ts, where
 * the reasoning for the cascade is written out.
 */
export async function deleteTag(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<number> {
  const rows = await readTags(ctx);
  const tag = rows.find((t) => t.id === id);
  if (!tag) throw new TagError(`Unknown tag: ${id}`);
  await writeTags(
    ctx,
    rows.filter((t) => t.id !== id),
  );
  return removeFromItems(ctx, tag.name);
}

/** How many items carry each tag, keyed by `tagKey(name)`. */
export async function tagUsageCounts(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const item of await readItems(ctx)) {
    if (!Array.isArray(item.tags)) continue;
    // Counted per item, not per occurrence: an item carrying two casings of
    // one tag is still one item that loses a chip when the tag goes.
    for (const key of new Set(item.tags.map((t) => tagKey(t)))) {
      if (key === "") continue;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** One item as the tag rewrites below care about it. */
interface TaggedItem {
  tags?: string[];
}

/** The items file, or an empty list when local mode has not written one yet. */
async function readItems(ctx: LocalStoreContext): Promise<TaggedItem[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "items"), "utf8"),
    ) as TaggedItem[];
  } catch {
    return [];
  }
}

async function writeItems(
  ctx: LocalStoreContext,
  items: TaggedItem[],
): Promise<void> {
  await fs.writeFile(
    localPath(ctx.root, "items"),
    JSON.stringify(items, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Rewrite every item's tags with `map`, and report how many items changed.
 *
 * `map` returns the replacement for one tag, or null to drop it, which is the
 * only difference between a rename, a merge and a delete. The de-duplication
 * and the write-only-if-changed are shared, because getting either wrong is
 * silent: a duplicated tag draws twice on a card, and an unconditional write
 * churns the file on every no-op.
 */
async function rewriteItemTags(
  ctx: LocalStoreContext,
  map: (tag: string) => string | null,
): Promise<number> {
  const items = await readItems(ctx);
  let changed = 0;
  for (const item of items) {
    if (!Array.isArray(item.tags)) continue;
    const seen = new Set<string>();
    const next: string[] = [];
    for (const tag of item.tags) {
      const value = map(tag);
      if (value === null) continue;
      const key = tagKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(value);
    }
    if (
      next.length !== item.tags.length ||
      next.some((t, i) => t !== item.tags![i])
    ) {
      item.tags = next;
      changed++;
    }
  }
  if (changed > 0) await writeItems(ctx, items);
  return changed;
}

/**
 * Carry a rename onto every item that carries the old name, matching
 * case-insensitively so values written before the registry existed (or
 * imported from spec frontmatter) are picked up too.
 *
 * De-duplicates, keeping the first occurrence so the author's order survives. A
 * plain rename rarely needs that (an item would have to carry two legacy
 * casings of the same tag), but a merge always does: an item tagged with both
 * `SF` and `Salesforce` must come out carrying `Salesforce` once.
 */
async function renameOnItems(
  ctx: LocalStoreContext,
  previous: string,
  next: string,
): Promise<void> {
  const from = tagKey(previous);
  await rewriteItemTags(ctx, (tag) => (tagKey(tag) === from ? next : tag));
}

/**
 * Take a tag off every item that carries it, case-insensitively so a legacy
 * casing goes with it. Returns how many items changed.
 */
async function removeFromItems(
  ctx: LocalStoreContext,
  name: string,
): Promise<number> {
  const target = tagKey(name);
  return rewriteItemTags(ctx, (tag) => (tagKey(tag) === target ? null : tag));
}
