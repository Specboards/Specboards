import { getStore, type WorkspaceScope } from "@/lib/store";
import type { NotificationList } from "@/lib/store/types";

/** A user's notification inbox: reading it, and marking it read. */

/** The caller's notifications plus their unread total. */
export async function listNotifications(
  scope?: WorkspaceScope,
): Promise<NotificationList> {
  const store = await getStore();
  return store.listNotifications(scope);
}

/** Mark one of the caller's notifications read. */
export async function markNotificationRead(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markNotificationRead(id, scope);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.markAllNotificationsRead(scope);
}
