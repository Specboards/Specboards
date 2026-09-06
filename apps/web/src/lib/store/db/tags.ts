/**
 * The workspace tag registry, in the database store.
 *
 * Tags used to be free text in `features.tags`, so three spellings of one tag
 * were three tags. This is the list that decides which spelling is the
 * spelling; see `packages/core/src/tags.ts` for the matching rules and the
 * migration for why item values still live in `features.tags` rather than in a
 * join table.
 */

import {
  TagError,
  normalizeTagName,
  tagKey,
  tagNameError,
  type TagDef,
} from "@specboards/core";

import { asc, eq, features, sql, workspaceTags } from "@specboards/db";

import type { WorkspaceScope } from "../types";

import type { DbStoreContext, Tx } from "./context";

function toTagDef(row: { id: string; name: string; position: number }): TagDef {
  return { id: row.id, name: row.name, position: row.position };
}

/** The registry for one workspace, in display order. */
async function tagsIn(tx: Tx, ws: string): Promise<TagDef[]> {
  const rows = await tx
    .select()
    .from(workspaceTags)
    .where(eq(workspaceTags.workspaceId, ws))
    .orderBy(asc(workspaceTags.position), asc(workspaceTags.createdAt));
  return rows.map(toTagDef);
}

export async function listTags(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<TagDef[]> {
  return ctx.scoped(scope, async (tx) => tagsIn(tx, scope!.workspaceId));
}

/**
 * Add any of `names` the registry does not already hold, then return the whole
 * registry.
 *
 * Idempotent, and deliberately silent about which names were new: the caller is
 * usually an item write that resolved several names at once and has no use for
 * the distinction. New rows are appended, so a tag created from a card lands at
 * the end of the list rather than jumping into the middle of an order an admin
 * arranged.
 *
 * `onConflictDoNothing` on the case-insensitive unique index rather than a
 * read-then-write, because two people can tag two cards with the same new name
 * at the same time and the check-then-insert version loses that race with a
 * constraint violation the user did not cause.
 */
export async function ensureTags(
  ctx: DbStoreContext,
  names: string[],
  scope?: WorkspaceScope,
): Promise<TagDef[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const existing = await tagsIn(tx, ws);
    const known = new Set(existing.map((t) => tagKey(t.name)));
    const fresh: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = normalizeTagName(raw);
      if (name === "") continue;
      const problem = tagNameError(name);
      if (problem) throw new TagError(problem);
      const key = tagKey(name);
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push(name);
    }
    if (fresh.length === 0) return existing;

    let position = existing.reduce((m, t) => Math.max(m, t.position), -1) + 1;
    await tx
      .insert(workspaceTags)
      .values(
        fresh.map((name) => ({ workspaceId: ws, name, position: position++ })),
      )
      // Untargeted on purpose. The uniqueness this is guarding is a functional
      // index on (workspace_id, lower(name)), and a conflict target has to be
      // named by column, which Drizzle cannot do for an expression. Naming no
      // target means "any constraint", which here is only ever that index: the
      // primary key is a fresh gen_random_uuid on every row and has nothing to
      // collide with.
      .onConflictDoNothing();
    return tagsIn(tx, ws);
  });
}

/**
 * Rename a tag and carry the change to every item that carries it.
 *
 * This is the operation the registry exists to make possible. Without a table,
 * renaming a tag means rewriting a value inside a thousand arrays with nothing
 * recording that they were ever the same tag; with one it is an UPDATE and a
 * single array rewrite, in one transaction, so an item can never be left
 * pointing at a name that no longer exists.
 *
 * Renaming onto an existing name is refused rather than silently merging. A
 * merge is a reasonable thing to want and a bad thing to do by accident, and it
 * is not what someone fixing a typo is asking for.
 */
export async function renameTag(
  ctx: DbStoreContext,
  id: string,
  name: string,
  scope?: WorkspaceScope,
): Promise<TagDef> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const next = normalizeTagName(name);
    const problem = tagNameError(next);
    if (problem) throw new TagError(problem);

    const existing = await tagsIn(tx, ws);
    const tag = existing.find((t) => t.id === id);
    if (!tag) throw new TagError(`Unknown tag: ${id}`);
    const clash = existing.find(
      (t) => t.id !== id && tagKey(t.name) === tagKey(next),
    );
    if (clash) {
      throw new TagError(
        `"${clash.name}" already exists. Rename this tag to something else, or merge the two with a bulk upload.`,
      );
    }
    if (tag.name === next) return tag;

    const [row] = await tx
      .update(workspaceTags)
      .set({ name: next })
      .where(eq(workspaceTags.id, id))
      .returning();
    if (!row) throw new TagError(`Unknown tag: ${id}`);

    // Rewrite the old name wherever it appears on an item, matching
    // case-insensitively so values that predate the registry (or came in
    // through spec frontmatter) are picked up too. array_replace only handles
    // an exact match, hence the explicit rebuild.
    await tx.execute(sql`
      UPDATE ${features}
      SET tags = (
        SELECT array_agg(
          CASE WHEN lower(t) = lower(${tag.name}) THEN ${next} ELSE t END
          ORDER BY ord
        )
        FROM unnest(${features}.tags) WITH ORDINALITY AS u(t, ord)
      )
      WHERE ${features}.workspace_id = ${ws}
        AND EXISTS (
          SELECT 1 FROM unnest(${features}.tags) AS t
          WHERE lower(t) = lower(${tag.name})
        )
    `);

    return toTagDef(row);
  });
}

/**
 * Fold one tag into another: rewrite the source name to the target's on every
 * item, then drop the source definition.
 *
 * This is what a bulk mapping file needs and what `renameTag` deliberately
 * refuses. The distinction is about intent, not capability: renaming one row in
 * settings is a typo fix, where quietly absorbing another tag would be a
 * surprise, whereas a CSV that maps `SF` to an existing `Salesforce` is asking
 * for exactly this and says so in the preview before it runs.
 *
 * The rewrite de-duplicates, because an item tagged with both spellings would
 * otherwise end up carrying the survivor twice. `DISTINCT ON (lower(t))`
 * ordered by ordinality keeps the first occurrence, and the outer `array_agg`
 * puts the array back in its original order, so a merge never reshuffles tags
 * an author arranged.
 */
export async function mergeTags(
  ctx: DbStoreContext,
  sourceId: string,
  targetId: string,
  scope?: WorkspaceScope,
): Promise<TagDef> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    if (sourceId === targetId) {
      throw new TagError("A tag cannot be merged into itself.");
    }
    const existing = await tagsIn(tx, ws);
    const source = existing.find((t) => t.id === sourceId);
    if (!source) throw new TagError(`Unknown tag: ${sourceId}`);
    const target = existing.find((t) => t.id === targetId);
    if (!target) throw new TagError(`Unknown tag: ${targetId}`);

    await tx.execute(sql`
      UPDATE ${features}
      SET tags = (
        SELECT COALESCE(array_agg(t ORDER BY ord), ARRAY[]::text[])
        FROM (
          SELECT DISTINCT ON (lower(t)) t, ord
          FROM (
            SELECT
              CASE WHEN lower(raw) = lower(${source.name}) THEN ${target.name} ELSE raw END AS t,
              ord
            FROM unnest(${features}.tags) WITH ORDINALITY AS u(raw, ord)
          ) mapped
          ORDER BY lower(t), ord
        ) deduped
      )
      WHERE ${features}.workspace_id = ${ws}
        AND EXISTS (
          SELECT 1 FROM unnest(${features}.tags) AS raw
          WHERE lower(raw) = lower(${source.name})
        )
    `);

    const removed = await tx
      .delete(workspaceTags)
      .where(eq(workspaceTags.id, sourceId))
      .returning({ id: workspaceTags.id });
    if (removed.length === 0) throw new TagError(`Unknown tag: ${sourceId}`);

    return target;
  });
}

/**
 * Delete a tag: take it off every item that carries it, then drop the
 * definition. Returns how many items were changed.
 *
 * This used to leave item values alone, the bargain `deleteProperty` still
 * makes, on the reasoning that a definition going away should hide values
 * rather than destroy them. Tags turned out not to work that way. A custom
 * property's value is content somebody typed into a field; a tag IS the field,
 * so a "hidden" tag was not a value waiting to come back, it was a chip still
 * drawn on a card, still filterable through `mergeTagOptions`, and absent from
 * the one screen that claimed to manage tags. Deleting it and watching it stay
 * on the board is the surprise, not the cascade.
 *
 * So delete now means delete, and the confirmation carries the weight instead:
 * the caller types the tag's name, and the UI shows how many items it is on
 * first (see `tagUsageCounts`). There is still no undo, which is exactly why
 * the count is on screen before the button works.
 *
 * Both statements run in one transaction: an item can never be left carrying a
 * tag whose definition has already gone.
 */
export async function deleteTag(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<number> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const existing = await tagsIn(tx, ws);
    const tag = existing.find((t) => t.id === id);
    if (!tag) throw new TagError(`Unknown tag: ${id}`);

    // Matched case-insensitively so a legacy `Area:Web` written before the
    // registry (or imported from spec frontmatter) is stripped too. Leaving it
    // behind would recreate exactly the orphaned-chip problem this change is
    // getting rid of.
    // `RETURNING` rather than the driver's affected-row count, so the number
    // handed back is rows this statement actually rewrote and does not depend
    // on which driver is underneath.
    const stripped = (await tx.execute(sql`
      UPDATE ${features}
      SET tags = (
        SELECT COALESCE(array_agg(t ORDER BY ord), ARRAY[]::text[])
        FROM unnest(${features}.tags) WITH ORDINALITY AS u(t, ord)
        WHERE lower(t) <> lower(${tag.name})
      )
      WHERE ${features}.workspace_id = ${ws}
        AND EXISTS (
          SELECT 1 FROM unnest(${features}.tags) AS t
          WHERE lower(t) = lower(${tag.name})
        )
      RETURNING ${features}.id
    `)) as unknown as { id: string }[];

    const removed = await tx
      .delete(workspaceTags)
      .where(eq(workspaceTags.id, id))
      .returning({ id: workspaceTags.id });
    // A write RLS drop matches zero rows and would otherwise be reported as a
    // successful delete; same reason setTransitionMode checks its row count.
    if (removed.length === 0) throw new TagError(`Unknown tag: ${id}`);

    return stripped.length;
  });
}

/**
 * How many items carry each tag, keyed by `tagKey(name)`.
 *
 * One aggregate over the workspace rather than a count per tag, because the
 * settings page needs every number at once and a list of forty tags should not
 * be forty queries. Tags nobody uses are simply absent from the map; the caller
 * reads a missing key as zero.
 *
 * Keyed case-insensitively to match everywhere else tags are compared, so an
 * item carrying a legacy `Area:Web` counts towards `area:web` -- which is the
 * honest number, because deleting that tag will strip that item too.
 */
export async function tagUsageCounts(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<Record<string, number>> {
  return ctx.scoped(scope, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT lower(t) AS key, count(DISTINCT ${features}.id)::int AS count
      FROM ${features}, unnest(${features}.tags) AS t
      WHERE ${features}.workspace_id = ${scope!.workspaceId}
      GROUP BY lower(t)
    `)) as unknown as { key: string; count: number }[];
    const out: Record<string, number> = {};
    for (const row of rows) out[row.key] = row.count;
    return out;
  });
}
