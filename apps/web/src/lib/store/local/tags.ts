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
      `"${clash.name}" already exists. Rename this tag to something else, or delete it and re-tag its items.`,
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

export async function deleteTag(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readTags(ctx);
  if (!rows.some((t) => t.id === id)) throw new TagError(`Unknown tag: ${id}`);
  // Item values are left in place, as in the db store: dropping a tag hides
  // values rather than destroying them.
  await writeTags(
    ctx,
    rows.filter((t) => t.id !== id),
  );
}

/**
 * Carry a rename onto every item that carries the old name, matching
 * case-insensitively so values written before the registry existed (or
 * imported from spec frontmatter) are picked up too.
 *
 * De-duplicates afterwards, keeping the first occurrence so the author's order
 * survives. A plain rename rarely needs this (an item would have to carry two
 * legacy casings of the same tag), but a merge always does: an item tagged with
 * both `SF` and `Salesforce` must come out carrying `Salesforce` once.
 */
async function renameOnItems(
  ctx: LocalStoreContext,
  previous: string,
  next: string,
): Promise<void> {
  const file = localPath(ctx.root, "items");
  let items: { tags?: string[] }[];
  try {
    items = JSON.parse(await fs.readFile(file, "utf8")) as { tags?: string[] }[];
  } catch {
    return;
  }
  const from = tagKey(previous);
  let touched = false;
  for (const item of items) {
    if (!Array.isArray(item.tags)) continue;
    const seen = new Set<string>();
    const mapped: string[] = [];
    for (const tag of item.tags) {
      const value = tagKey(tag) === from ? next : tag;
      const key = tagKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      mapped.push(value);
    }
    if (
      mapped.length !== item.tags.length ||
      mapped.some((t, i) => t !== item.tags![i])
    ) {
      item.tags = mapped;
      touched = true;
    }
  }
  if (touched) {
    await fs.writeFile(file, JSON.stringify(items, null, 2) + "\n", "utf8");
  }
}
