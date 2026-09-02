"use client";

import { apiFetch } from "@/lib/api-client/request";
import type { NotificationList } from "@/lib/store/types";

/** The caller's notification inbox (items + unread count). */
export async function listNotifications(): Promise<NotificationList> {
  const res = await apiFetch("/api/v1/notifications");
  const body = (await res.json().catch(() => null)) as
    (NotificationList & { error?: string }) | null;
  if (!res.ok || !body?.items) {
    throw new Error(
      body?.error ?? `Failed to load notifications (${res.status}).`,
    );
  }
  return { items: body.items, unreadCount: body.unreadCount };
}

/** Mark one notification read. */
export async function markNotificationRead(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to mark read (${res.status}).`);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(): Promise<void> {
  const res = await apiFetch("/api/v1/notifications/read-all", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to mark all read (${res.status}).`);
}
