"use client";

import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  AuthRequiredError,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/api-client";
import { useOrgSlug } from "@/lib/use-org";
import { cn } from "@/lib/utils";
import type { NotificationRecord } from "@/lib/store/types";

/** How often to poll the inbox (ms). No realtime transport exists yet, so the
 * bell polls; keep it modest to avoid hammering the API. */
const POLL_MS = 45_000;

function timeAgo(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return "";
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Notification inbox bell for the sidebar footer. Polls the caller's inbox,
 * shows an unread badge, and opens a panel of @mention notifications. Clicking
 * one marks it read and deep-links to the item the source comment lives on.
 */
export function NotificationBell({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const org = useOrgSlug();
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const inbox = await listNotifications();
      setItems(inbox.items);
      setUnread(inbox.unreadCount);
    } catch (err) {
      // A signed-out poll is expected on public routes; ignore quietly.
      if (!(err instanceof AuthRequiredError)) {
        // Swallow transient errors; the next tick retries.
      }
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  function itemHref(n: NotificationRecord): string {
    return `/${org}/${n.productSlug}/backlog/${n.featureLevel}/${n.specId}`;
  }

  async function openNotification(n: NotificationRecord) {
    setOpen(false);
    if (!n.read) {
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
      );
      setUnread((u) => Math.max(0, u - 1));
      markNotificationRead(n.id).catch(() => refresh());
    }
    router.push(itemHref(n));
  }

  async function onMarkAll() {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      refresh();
    }
  }

  return (
    <div className={cn("relative", collapsed ? "flex justify-center" : "")}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) refresh();
        }}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        className={cn(
          "relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
          collapsed ? "justify-center" : "w-full",
        )}
      >
        <Bell className="h-4 w-4 shrink-0" />
        {!collapsed ? <span>Notifications</span> : null}
        {unread > 0 ? (
          <span
            className={cn(
              "flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground",
              collapsed ? "absolute -right-0.5 -top-0.5" : "ml-auto",
            )}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 z-40 mb-2 max-h-96 w-80 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Notifications
              </span>
              {unread > 0 ? (
                <button
                  type="button"
                  onClick={onMarkAll}
                  className="text-xs text-link hover:underline"
                >
                  Mark all read
                </button>
              ) : null}
            </div>
            {items.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                No notifications yet.
              </p>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => openNotification(n)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 rounded px-2 py-2 text-left hover:bg-accent",
                        !n.read ? "bg-accent/40" : "",
                      )}
                    >
                      <div className="flex w-full items-center gap-2">
                        {!n.read ? (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                        <span className="truncate text-sm">
                          <span className="font-medium">
                            {n.actorName ?? "Someone"}
                          </span>{" "}
                          mentioned you
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          {timeAgo(n.createdAt)}
                        </span>
                      </div>
                      <span className="truncate text-xs text-muted-foreground">
                        {n.featureTitle}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {n.snippet}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
