"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  NotificationList,
  NotificationQuery,
} from "@/lib/store/types";

/**
 * A page of the caller's inbox.
 *
 * The bell calls this with nothing and gets the newest page; the notification
 * centre passes filters and a cursor. `unreadCount` is the whole inbox either
 * way, so the badge does not change when a filter does.
 */
export async function listNotifications(
  query: NotificationQuery = {},
): Promise<NotificationList> {
  const params = new URLSearchParams();
  if (query.unreadOnly) params.set("unread", "1");
  for (const t of query.types ?? []) params.append("type", t);
  if (query.productKey) params.set("product", query.productKey);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.before) params.set("before", query.before);
  // The query is always appended, even when empty. `api-client-routes.test.ts`
  // resolves each call's path by stripping everything from the first `?`, and a
  // conditional suffix glued to the last path segment reads as a different
  // route to it. An empty query string costs nothing and keeps that check able
  // to see this call.
  const res = await apiFetch(`/api/v1/notifications?${params.toString()}`);
  const body = (await res.json().catch(() => null)) as
    | (NotificationList & { error?: string })
    | null;
  if (!res.ok || !body?.items) {
    throw new Error(
      body?.error ?? `Failed to load notifications (${res.status}).`,
    );
  }
  return {
    items: body.items,
    unreadCount: body.unreadCount,
    nextCursor: body.nextCursor ?? null,
  };
}

/** Mark one notification read. */
export async function markNotificationRead(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to mark read (${res.status}).`);
}

/** Mark one notification unread again. */
export async function markNotificationUnread(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/notifications/${encodeURIComponent(id)}/unread`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to mark unread (${res.status}).`);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(): Promise<void> {
  const res = await apiFetch("/api/v1/notifications/read-all", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to mark all read (${res.status}).`);
}
