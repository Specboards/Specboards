import { getStore, type WorkspaceScope } from "@/lib/store";
import type { NotificationList, NotificationQuery } from "@/lib/store/types";

/** A user's notification inbox: reading it, and marking it read. */

/** Cap on how many types one request may filter by, so the URL cannot grow
 * unbounded and the `IN` list stays a sane size. The catalog is far smaller
 * than this, so it only ever rejects a hand-written request. */
const MAX_TYPE_FILTERS = 25;

/**
 * Read a page of the caller's inbox from query parameters.
 *
 * Parsing lives here rather than in the route so the shape is validated once,
 * whoever asks. Unknown parameters are ignored rather than rejected: a filter
 * the client does not understand should narrow nothing, not fail the page.
 */
export function parseNotificationQuery(params: URLSearchParams): NotificationQuery {
  const query: NotificationQuery = {};
  if (params.get("unread") === "1") query.unreadOnly = true;
  const types = params.getAll("type").filter((t) => t !== "");
  if (types.length > 0) query.types = types.slice(0, MAX_TYPE_FILTERS);
  const product = params.get("product");
  if (product) query.productKey = product;
  const limit = Number(params.get("limit"));
  if (Number.isFinite(limit) && limit > 0) query.limit = Math.floor(limit);
  const before = params.get("before");
  if (before) query.before = before;
  return query;
}

/** A page of the caller's notifications plus their unread total. */
export async function listNotifications(
  scope?: WorkspaceScope,
  query?: NotificationQuery,
): Promise<NotificationList> {
  const store = await getStore();
  return store.listNotifications(scope, query);
}

/** Mark one of the caller's notifications read. */
export async function markNotificationRead(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markNotificationRead(id, scope);
}

/** Mark one of the caller's notifications unread again. */
export async function markNotificationUnread(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markNotificationUnread(id, scope);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markAllNotificationsRead(scope);
}
