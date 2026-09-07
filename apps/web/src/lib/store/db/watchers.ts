/**
 * Watching an item: reading who is listening, and joining or leaving.
 *
 * The write side is deliberately small. A watch is one person's decision about
 * their own attention, so there is one verb (set my state on this item) and no
 * way to express anybody else's. The auto-watch rules, which are the one place
 * a row appears for somebody other than the caller, live in the relay instead;
 * see `lib/notifications/fanout.ts` for why, and the RLS policies in migration
 * 0003 for what enforces it.
 *
 * The read side answers two questions at once, because the control needs both:
 * who is on this item, and what am I. The second is not simply "do I have a
 * row": being assigned an item follows it by default, so the effective answer
 * folds an inferred interest together with an explicit decision that outranks
 * it.
 */

import { and, eq, features, itemWatchers, users } from "@specboards/db";

import {
  CommentError,
  type ItemWatchState,
  type WatchInput,
  type WatcherRecord,
  type WorkspaceScope,
} from "../types";

import { canReadProductId, type DbStoreContext, type Tx } from "./context";

export async function listWatchers(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<ItemWatchState> {
  return ctx.scoped(scope, async (tx) => {
    const item = await readableItem(ctx, tx, scope!, specId);
    return watchState(tx, scope!, item);
  });
}

export async function setWatch(
  ctx: DbStoreContext,
  specId: string,
  input: WatchInput,
  scope?: WorkspaceScope,
): Promise<ItemWatchState> {
  return ctx.scoped(scope, async (tx) => {
    const item = await readableItem(ctx, tx, scope!, specId);
    const userId = scope!.userId;

    // Written rather than deleted when the answer is no. An absent row means
    // "nothing said", and for the assignee that resolves to watching; the only
    // way to say "I am assigned to this and do not want to hear about it" is a
    // row that says so.
    await tx
      .insert(itemWatchers)
      .values({
        workspaceId: scope!.workspaceId,
        featureId: item.id,
        userId,
        watching: input.watching,
        includeDescendants: input.includeDescendants ?? false,
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [
          itemWatchers.workspaceId,
          itemWatchers.featureId,
          itemWatchers.userId,
        ],
        set: {
          watching: input.watching,
          includeDescendants: input.includeDescendants ?? false,
          // An auto row a person has since touched is theirs, and the watcher
          // list should stop describing it as something the system did.
          source: "manual",
          updatedAt: new Date(),
        },
      });

    return watchState(tx, scope!, item);
  });
}

/** Who is on the item, and where the caller stands. */
async function watchState(
  tx: Tx,
  scope: WorkspaceScope,
  item: ItemRow,
): Promise<ItemWatchState> {
  const rows = await tx
    .select({
      userId: itemWatchers.userId,
      watching: itemWatchers.watching,
      includeDescendants: itemWatchers.includeDescendants,
      source: itemWatchers.source,
      name: users.name,
      image: users.image,
    })
    .from(itemWatchers)
    .leftJoin(users, eq(users.id, itemWatchers.userId))
    .where(
      and(
        eq(itemWatchers.workspaceId, scope.workspaceId),
        eq(itemWatchers.featureId, item.id),
      ),
    );

  const mine = rows.find((r) => r.userId === scope.userId);
  const watchers: WatcherRecord[] = rows
    .filter((r) => r.watching)
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      image: r.image,
      source: r.source === "auto" ? "auto" : "manual",
    }));

  return {
    watchers,
    // The effective answer, not the stored one. An assignee with no row of
    // their own is watching; the same person with a row saying no is not.
    watching: mine ? mine.watching : item.assigneeId === scope.userId,
    /* Whether the caller has actually said something. The control uses it to
     * explain a state the reader did not choose ("you follow this because it
     * is assigned to you"), which is the difference between a setting that
     * looks broken and one that looks obvious. */
    explicit: Boolean(mine),
    includeDescendants: mine?.includeDescendants ?? false,
  };
}

interface ItemRow {
  id: string;
  assigneeId: string | null;
}

/**
 * The item, if the caller may see it.
 *
 * Watchers are readable by the whole workspace, but only through an item the
 * reader can reach: the list is a fact about a private product's work as much
 * as the work itself is, and RLS on `item_watchers` keys on workspace
 * membership alone because the item id is only obtainable through this check.
 */
async function readableItem(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
  specId: string,
): Promise<ItemRow> {
  const [row] = await tx
    .select({
      id: features.id,
      assigneeId: features.assigneeId,
      productId: features.productId,
    })
    .from(features)
    .where(
      and(
        eq(features.workspaceId, scope.workspaceId),
        eq(features.specId, specId),
      ),
    )
    .limit(1);
  if (!row) throw new CommentError(`Unknown item: ${specId}`);

  const [access, productById] = await Promise.all([
    ctx.accessIn(tx, scope),
    ctx.productVisibilityIn(tx, scope.workspaceId),
  ]);
  if (!canReadProductId(access, productById, row.productId)) {
    throw new CommentError("You do not have access to this item.");
  }
  return { id: row.id, assigneeId: row.assigneeId };
}
