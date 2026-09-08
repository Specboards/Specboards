/**
 * Comments and notifications, in local file mode.
 *
 * The db store keeps these together because posting a comment that mentions
 * someone writes the notification rows in the same transaction. Here there is
 * no transaction and no one to mention: local mode has a single user, so
 * `listNotifications` is empty and the two marking methods do nothing. They are
 * still here, and still in this module, because the interface is one interface
 * and a store that silently lacked half of it would be a different contract.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";

import {
  resolveUserMatrix,
  resolveWorkspaceMatrix,
} from "@/lib/notifications/matrix";

import {
  CommentError,
  NotificationSettingsError,
  type CommentInput,
  type CommentRecord,
  type NotificationDefaultsView,
  type NotificationList,
  type NotificationPreferenceView,
  type NotificationQuery,
  type NotificationSettingChange,
  type WorkspaceScope,
} from "../types";

import { type LocalStoreContext } from "./context";
import { localPath } from "./paths";
import { LOCAL_USER } from "./types";

export async function listComments(
  ctx: LocalStoreContext,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<CommentRecord[]> {
  await assertItemExists(ctx, specId);
  const rows = await readComments(ctx);
  return rows
    .filter((c) => c.specId === specId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => ({
      id: c.id,
      featureId: c.specId,
      authorId: c.authorId,
      authorName: null,
      authorImage: null,
      body: c.body,
      createdAt: c.createdAt,
    }));
}

export async function createComment(
  ctx: LocalStoreContext,
  specId: string,
  input: CommentInput,
  _scope?: WorkspaceScope,
): Promise<CommentRecord> {
  const body = input.body.trim();
  if (!body) throw new CommentError("Comment body is required.");
  await assertItemExists(ctx, specId);
  const rows = await readComments(ctx);
  const comment: LocalComment = {
    id: randomUUID(),
    specId,
    authorId: LOCAL_USER,
    body,
    createdAt: new Date().toISOString(),
  };
  await ctx.writeJsonFile(localPath(ctx.root, "comments"), [...rows, comment]);
  return {
    id: comment.id,
    featureId: specId,
    authorId: comment.authorId,
    authorName: null,
    authorImage: null,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

export async function deleteComment(
  ctx: LocalStoreContext,
  commentId: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readComments(ctx);
  if (!rows.some((c) => c.id === commentId)) {
    throw new CommentError(`Unknown comment: ${commentId}`);
  }
  await ctx.writeJsonFile(
    localPath(ctx.root, "comments"),
    rows.filter((c) => c.id !== commentId),
  );
}

// Notifications are a multi-user, @mention-driven concept; local file mode is
// a single user with no members to mention, so the inbox is always empty.
export async function listNotifications(
  _scope?: WorkspaceScope,
  _query?: NotificationQuery,
): Promise<NotificationList> {
  return { items: [], unreadCount: 0, nextCursor: null };
}

export async function markNotificationRead(
  _id: string,
  _scope?: WorkspaceScope,
): Promise<void> {}

export async function markNotificationUnread(
  _id: string,
  _scope?: WorkspaceScope,
): Promise<void> {}

export async function markAllNotificationsRead(
  _scope?: WorkspaceScope,
): Promise<void> {}

/**
 * Notification settings, in local file mode.
 *
 * Nothing here has anybody to notify: the inbox above is always empty for the
 * same reason. The settings still resolve, to the catalog values with no
 * override at either level, so the grid renders honestly if it is ever asked
 * to. Writes refuse rather than quietly succeeding, because a saved preference
 * that can never change anything is worse than being told so.
 */
export async function getNotificationPreferences(
  _scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  return { rows: resolveUserMatrix([], []) };
}

export async function updateNotificationPreferences(
  _changes: readonly NotificationSettingChange[],
  _scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  throw new NotificationSettingsError(
    "Notification settings are unavailable in local file mode.",
  );
}

export async function getNotificationDefaults(
  _scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  return { rows: resolveWorkspaceMatrix([]), overrideCounts: {} };
}

export async function updateNotificationDefaults(
  _changes: readonly NotificationSettingChange[],
  _scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  throw new NotificationSettingsError(
    "Notification settings are unavailable in local file mode.",
  );
}

async function readComments(ctx: LocalStoreContext): Promise<LocalComment[]> {
  return ctx.readJsonFile<LocalComment>(localPath(ctx.root, "comments"));
}

async function assertItemExists(
  ctx: LocalStoreContext,
  specId: string,
): Promise<void> {
  const all = await ctx.loadAll();
  if (!all.some((f) => f.specId === specId)) {
    throw new CommentError(`Unknown item: ${specId}`);
  }
}

/** A comment persisted in local file mode. Keyed to the feature's stable
 * specId (local mode has no separate internal id) and authored by LOCAL_USER,
 * since file mode has no user records. */
interface LocalComment {
  id: string;
  specId: string;
  authorId: string;
  body: string;
  createdAt: string;
}
