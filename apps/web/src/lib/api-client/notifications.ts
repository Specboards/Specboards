"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  NotificationDefaultsView,
  NotificationList,
  NotificationPreferenceView,
  NotificationQuery,
  NotificationSettingChange,
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

/**
 * Notification settings. Both grids read and write the same shape, and both
 * write calls answer with the whole grid rather than an acknowledgement, so
 * the caller re-renders from the server's view of it instead of guessing what
 * a change did to the rows around it.
 *
 * Each call names its path as a literal rather than sharing one helper that
 * takes a `path` argument. `api-client-routes.test.ts` reads these call sites
 * to check that every path resolves to a route file exporting that method, and
 * a path it cannot see is a path it cannot check. The shared part is the
 * unwrapping below, which takes the response and never the URL.
 */
async function unwrap<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok || !body) {
    throw new Error(body?.error ?? `Failed to load ${what} (${res.status}).`);
  }
  return body;
}

/** A PATCH body carrying a batch of cell changes. */
function patchInit(changes: readonly NotificationSettingChange[]): RequestInit {
  return {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  };
}

const SETTINGS = "notification settings";
const DEFAULTS = "workspace notification defaults";

/* There is no client-side read of either grid. Both pages render their first
 * state on the server, and every write answers with the whole grid, so a
 * browser-side GET would have no caller. The routes still serve GET, which is
 * how anything outside the app reads these settings. */

/** Set or clear the caller's overrides. `enabled: null` returns a row to
 * inheriting. */
export async function updateNotificationPreferences(
  changes: readonly NotificationSettingChange[],
): Promise<NotificationPreferenceView> {
  const res = await apiFetch(
    "/api/v1/notifications/preferences",
    patchInit(changes),
  );
  return unwrap<NotificationPreferenceView>(res, SETTINGS);
}

/** Set or clear a workspace default. Admins only. */
export async function updateNotificationDefaults(
  changes: readonly NotificationSettingChange[],
): Promise<NotificationDefaultsView> {
  const res = await apiFetch(
    "/api/v1/notifications/defaults",
    patchInit(changes),
  );
  return unwrap<NotificationDefaultsView>(res, DEFAULTS);
}
