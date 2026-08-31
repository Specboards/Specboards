/**
 * Comments and notifications: the two halves of one conversation.
 *
 * They share a module because they share a write. Posting a comment that
 * mentions someone inserts the notification rows in the same transaction as
 * the comment itself, so a mention can never exist without the comment that
 * made it, and a comment can never be posted without notifying the people it
 * names. Splitting them would put that invariant across a seam.
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
  members,
  notifications,
  products,
  users,
} from "@specboards/db";

import {
  CommentError,
  type CommentInput,
  type CommentRecord,
  type NotificationList,
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

    // Fan out @mention notifications in the SAME transaction as the comment,
    // so a crash can't leave a comment without its notices (or vice-versa).
    // Recipients are the mentioned users that are active workspace members,
    // minus the author, de-duped. A `comment.mentioned` outbox event lets
    // future delivery channels (email/Slack) hook in without touching ctx.
    const mentioned = [...new Set(input.mentionedUserIds ?? [])].filter(
      (id) => id !== scope!.userId,
    );
    if (mentioned.length > 0) {
      const activeRows = await tx
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.workspaceId, ws),
            inArray(members.userId, mentioned),
            isNull(members.deactivatedAt),
          ),
        );
      const recipients = activeRows.map((r) => r.userId);
      if (recipients.length > 0) {
        const snippet = commentSnippet(body);
        await tx.insert(notifications).values(
          recipients.map((recipientId) => ({
            workspaceId: ws,
            recipientId,
            actorId: scope!.userId,
            type: "mention",
            featureId: feat.id,
            commentId: row.id,
            snippet,
          })),
        );
        await ctx.writeOutbox(tx, scope!, {
          type: "comment.mentioned",
          productId: feat.productId,
          data: {
            commentId: row.id,
            featureId: feat.id,
            specId,
            recipientIds: recipients,
            snippet,
          },
        });
      }
    }

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

export async function listNotifications(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<NotificationList> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const uid = scope!.userId;
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
        .where(
          and(
            eq(notifications.workspaceId, ws),
            eq(notifications.recipientId, uid),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(50),
      tx
        .select({ n: count() })
        .from(notifications)
        .where(
          and(
            eq(notifications.workspaceId, ws),
            eq(notifications.recipientId, uid),
            isNull(notifications.readAt),
          ),
        ),
    ]);
    const items = rows.map((r) => ({
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
    return { items, unreadCount: Number(unread[0]?.n ?? 0) };
  });
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
