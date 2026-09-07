import { sql, type Database } from "@specboards/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Who has explicitly asked to hear about an item.
 *
 * One of the sets the fan-out's recipient resolution unions, and the only one
 * a person can put themselves into. Everything else it knows about interest is
 * inferred from the data (you are the assignee, you were mentioned), which
 * means somebody who cares about an item they do not own could not be reached
 * at all.
 *
 * Keyed by the internal `features.id` rather than the public `specId`, because
 * that is what the notification rows and the watch table both key on.
 *
 * ── Why this walks up the tree ──────────────────────────────────────────────
 * A watch covers the exact item, and covers everything under it when the
 * watcher asked for that. So the answer for one item is its own watchers plus
 * the cascading watchers of every ancestor, which is a walk rather than a
 * lookup.
 *
 * The recursion is depth-limited. A parent cycle should be impossible and the
 * limit is not there to permit one: it is there because this runs inside the
 * relay's transaction, and a cycle that got in somehow would otherwise spin
 * forever holding a lock on the outbox rather than failing a single event.
 */
export async function watchersFor(
  tx: Tx,
  workspaceId: string,
  featureIds: readonly string[],
): Promise<Map<string, ItemAudience>> {
  const out = new Map<string, ItemAudience>(
    featureIds.map((id) => [id, { watching: [], muted: [] }]),
  );
  if (featureIds.length === 0) return out;

  const rows = await tx.execute<{
    leaf: string;
    user_id: string;
    watching: boolean;
    depth: number;
  }>(sql`
    with recursive chain as (
      select f.id as leaf, f.id as node, f.parent_id, 0 as depth
      from features f
      where f.id = any(${sql.param(featureIds as string[])}::uuid[])
        and f.workspace_id = ${workspaceId}::uuid
      union all
      select c.leaf, p.id, p.parent_id, c.depth + 1
      from chain c
      join features p on p.id = c.parent_id
      where c.depth < ${MAX_ANCESTOR_DEPTH}
    )
    select distinct c.leaf, w.user_id, w.watching, c.depth
    from chain c
    join item_watchers w
      on w.feature_id = c.node
     and w.workspace_id = ${workspaceId}::uuid
    -- An ancestor only reaches down when its watch asked to. The item's own
    -- rows are at depth 0 and are never filtered by that flag.
    --
    -- A mute is read at depth 0 only: saying no to an epic is not the same as
    -- saying no to every item under it, and reading it that way would make one
    -- click silently cover work the person had never seen.
    where (c.depth = 0 or (w.include_descendants and w.watching))
  `);

  for (const row of rows) {
    const audience = out.get(row.leaf);
    if (!audience) continue;
    (row.watching ? audience.watching : audience.muted).push(row.user_id);
  }
  return out;
}

/**
 * Everyone who has said something about one item, in either direction.
 *
 * The mutes are here rather than being filtered away because they have to
 * outrank an interest the caller infers for itself. Being assigned an item
 * follows it by default, and "stop telling me about this one" is the whole
 * point of the feature: a set of watchers alone cannot express it.
 */
interface ItemAudience {
  watching: string[];
  muted: string[];
}

/**
 * How far up the tree a cascading watch is looked for. The deepest hierarchy
 * the product offers is a handful of levels, so this is a guard rather than a
 * limit anybody reaches.
 */
const MAX_ANCESTOR_DEPTH = 10;
