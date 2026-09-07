/**
 * Comments and notifications: the two halves of one conversation.
 *
 * They share a module because they share a reading surface. Posting a comment
 * no longer inserts the notification rows directly; it records a
 * `comment.created` outbox event in the same transaction, and the notification
 * fan-out decides who hears about it. The invariant survives the move (the
 * event and the comment still commit together, so a comment nobody is told
 * about is still impossible), and the gain is that one place now answers "who
 * should be told" for every kind of change rather than each write site
 * answering it for itself.
 *
 * Reads on both sides are filtered by product visibility rather than refused:
 * a comment on an item the caller cannot see is not an error, it is simply
 * not there.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import {
  and,
  asc,
  comments,
  count,
  desc,
  eq,
  features,
  inArray,
  isNull,
  lt,
  or,
  notifications,
  products,
  users,
} from "@specboards/db";

import {
  CommentError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
  type NotificationQuery,
  type WorkspaceScope,
} from "../types";

import { canReadProductId, type DbStoreContext, type Tx } from "./context";

export async function listComments(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<CommentRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const feat = await featureForComment(ctx, tx, ws, specId);
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    if (!canReadProductId(access, productById, feat.productId)) {
      throw new CommentError("You do not have access to this item.");
    }
    const rows = await tx
      .select({
        id: comments.id,
        featureId: comments.featureId,
        authorId: comments.authorId,
        body: comments.body,
        createdAt: comments.createdAt,
        authorName: users.name,
        authorImage: users.image,
      })
      .from(comments)
      .leftJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.workspaceId, ws), eq(comments.featureId, feat.id)))
      .orderBy(asc(comments.createdAt));
    return rows.map(toCommentRecord);
  });
}

export async function createComment(
  ctx: DbStoreContext,
  specId: string,
  input: CommentInput,
  scope?: WorkspaceScope,
): Promise<CommentRecord> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const body = input.body.trim();
    if (!body) throw new CommentError("Comment body is required.");
    const feat = await featureForComment(ctx, tx, ws, specId);
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, ws),
    ]);
    // You can comment on any item you can read.
    if (!canReadProductId(access, productById, feat.productId)) {
      throw new CommentError("You do not have access to this item.");
    }
    const [row] = await tx
      .insert(comments)
      .values({
        workspaceId: ws,
        featureId: feat.id,
        authorId: scope!.userId,
        body,
      })
      .returning();
    if (!row) throw new CommentError("Failed to create the comment.");

    // Record the comment as an outbox event in the SAME transaction as the
    // comment itself, so a crash cannot leave a comment that nobody is ever
    // told about. Who hears about it, and whether it reaches them as a mention
    // or as an update on an item they follow, is resolved by the notification
    // fan-out off this event (see lib/notifications/fanout.ts).
    //
    // This used to insert the mention rows here, inline. Moving them behind the
    // event is what lets one place decide recipients for every kind of change,
    // rather than each write site inventing its own answer; the durability
    // argument for doing it inline is unchanged, because the event and the
    // comment still commit together.
    //
    // The mention list is passed through raw. The fan-out filters it to active
    // members and drops the author, and doing it twice in two places is how the
    // two would eventually disagree.
    await ctx.writeOutbox(tx, scope!, {
      type: "comment.created",
      productId: feat.productId,
      data: {
        commentId: row.id,
        featureId: feat.id,
        specId,
        mentionedUserIds: [...new Set(input.mentionedUserIds ?? [])],
        snippet: commentSnippet(body),
      },
    });

    // The author is the acting user; resolve their display fields so the
    // created row renders without a follow-up fetch.
    const author = await tx.query.users.findFirst({
      where: eq(users.id, scope!.userId),
      columns: { name: true, image: true },
    });
    return toCommentRecord({
      ...row,
      authorName: author?.name ?? null,
      authorImage: author?.image ?? null,
    });
  });
}

export async function deleteComment(
  ctx: DbStoreContext,
  commentId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.workspaceId, ws)))
      .limit(1);
    if (!current[0]) throw new CommentError(`Unknown comment: ${commentId}`);
    const access = await ctx.accessIn(tx, scope!);
    // The author can delete their own comment; the workspace owner any.
    if (current[0].authorId !== scope!.userId && !access.isOrgAdmin) {
      throw new CommentError("You can only delete your own comments.");
    }
    await tx
      .delete(comments)
      .where(and(eq(comments.id, commentId), eq(comments.workspaceId, ws)));
  });
}

/** Page size ceiling, so a hand-written `limit` cannot ask for the whole table. */
const NOTIFICATION_PAGE_MAX = 100;
const NOTIFICATION_PAGE_DEFAULT = 30;

export async function listNotifications(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  query: NotificationQuery = {},
): Promise<NotificationList> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const uid = scope!.userId;
    const limit = Math.min(
      Math.max(query.limit ?? NOTIFICATION_PAGE_DEFAULT, 1),
      NOTIFICATION_PAGE_MAX,
    );

    const mine = and(
      eq(notifications.workspaceId, ws),
      eq(notifications.recipientId, uid),
    );
    const filters = [mine];
    if (query.unreadOnly) filters.push(isNull(notifications.readAt));
    if (query.types && query.types.length > 0) {
      filters.push(inArray(notifications.type, query.types));
    }
    if (query.productKey) filters.push(eq(products.key, query.productKey));
    if (query.before) {
      const cursor = parseCursor(query.before);
      // Strictly after the cursor row in the same order the page is sorted by.
      // The second clause is what stops a tie at the page boundary from losing
      // rows: notifications written in one transaction share `created_at`, so
      // `created_at < T` alone would skip every other row at T.
      //
      // Without an id half (a hand-written `before=<iso>`) there is no tie to
      // break, and comparing a uuid column against an empty string would fail
      // in the database rather than degrade.
      filters.push(
        cursor.id
          ? or(
              lt(notifications.createdAt, cursor.createdAt),
              and(
                eq(notifications.createdAt, cursor.createdAt),
                lt(notifications.id, cursor.id),
              ),
            )!
          : lt(notifications.createdAt, cursor.createdAt),
      );
    }

    // One extra row, to learn whether there is another page without counting
    // the whole table on every request.
    const [rows, unread] = await Promise.all([
      tx
        .select({
          id: notifications.id,
          type: notifications.type,
          actorId: notifications.actorId,
          actorName: users.name,
          specId: features.specId,
          featureLevel: features.level,
          productKey: products.key,
          featureTitle: features.title,
          commentId: notifications.commentId,
          snippet: notifications.snippet,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .innerJoin(features, eq(features.id, notifications.featureId))
        .leftJoin(products, eq(products.id, features.productId))
        .leftJoin(users, eq(users.id, notifications.actorId))
        .where(and(...filters))
        // `id` is the tiebreaker, so the order is total and a cursor built
        // from the last row names exactly one position in it.
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit + 1),
      // Deliberately unfiltered beyond "mine and unread": this is the badge
      // number, and a count that moved when somebody changed a filter would be
      // answering a question nobody asked.
      tx
        .select({ n: count() })
        .from(notifications)
        .where(and(mine, isNull(notifications.readAt))),
    ]);

    const page = rows.slice(0, limit);
    const items = page.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actorId,
      actorName: r.actorName,
      specId: r.specId,
      featureLevel: r.featureLevel,
      // Fall back to the all-products view when the item has no product.
      productSlug: r.productKey ?? "all",
      featureTitle: r.featureTitle,
      commentId: r.commentId,
      snippet: r.snippet,
      read: r.readAt !== null,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      items,
      unreadCount: Number(unread[0]?.n ?? 0),
      nextCursor: rows.length > limit ? cursorFor(page.at(-1)) : null,
    };
  });
}

/**
 * The inbox cursor: a timestamp and the id of the row it names, so the position
 * is exact even when several rows share the timestamp.
 */
function cursorFor(
  row: { id: string; createdAt: Date } | undefined,
): string | null {
  return row ? `${row.createdAt.toISOString()}|${row.id}` : null;
}

function parseCursor(raw: string): { createdAt: Date; id: string } {
  const sep = raw.lastIndexOf("|");
  // The id half is optional so a cursor from an older client (or a hand-written
  // `before=<iso>`) still works; it just cannot break a tie.
  const stamp = sep === -1 ? raw : raw.slice(0, sep);
  const id = sep === -1 ? "" : raw.slice(sep + 1);
  const createdAt = new Date(stamp);
  // A cursor we cannot parse is a caller error, and starting from "now" would
  // silently serve page one again forever.
  if (Number.isNaN(createdAt.getTime())) {
    throw new CommentError("That notification cursor is not valid.");
  }
  return { createdAt, id };
}

export async function markNotificationRead(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.workspaceId, scope!.workspaceId),
          eq(notifications.recipientId, scope!.userId),
          isNull(notifications.readAt),
        ),
      );
  });
}

export async function markNotificationUnread(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .update(notifications)
      .set({ readAt: null })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.workspaceId, scope!.workspaceId),
          eq(notifications.recipientId, scope!.userId),
        ),
      );
  });
}

export async function markAllNotificationsRead(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.workspaceId, scope!.workspaceId),
          eq(notifications.recipientId, scope!.userId),
          isNull(notifications.readAt),
        ),
      );
  });
}

/**
 * Resolve a feature by its stable specId to the internal id + product the
 * comment methods key on (comments reference `features.id`, but the API and
 * store take the stable specId). Scoped to the workspace so a specId from
 * another tenant can't be reached.
 */
async function featureForComment(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  specId: string,
): Promise<{ id: string; productId: string | null }> {
  const row = await tx
    .select({ id: features.id, productId: features.productId })
    .from(features)
    .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)))
    .limit(1);
  if (!row[0]) throw new CommentError(`Unknown item: ${specId}`);
  return row[0];
}

/** A short single-line preview of a comment body for the notification inbox. */
function commentSnippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? flat.slice(0, 139) + "…" : flat;
}

function toCommentRecord(row: {
  id: string;
  featureId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
  authorImage: string | null;
}): CommentRecord {
  return {
    id: row.id,
    featureId: row.featureId,
    authorId: row.authorId,
    authorName: row.authorName,
    authorImage: row.authorImage,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
