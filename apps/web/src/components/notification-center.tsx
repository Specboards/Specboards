"use client";

import { CheckCheck, Inbox } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
} from "@/lib/api-client/notifications";
import { groupNotifications } from "@/lib/notification-groups";
import { notificationHeadline as headline } from "@/lib/notification-copy";
import {
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENT_TYPES,
} from "@/lib/notifications/catalog";
import { orgProductPath } from "@/lib/org-path";
import type { NotificationList, NotificationRecord } from "@/lib/store/types";
import { useOrgSlug } from "@/lib/use-org";
import { cn } from "@/lib/utils";

/**
 * The notification centre.
 *
 * Three things the bell panel could not do, and each is why this page exists:
 * filtering (unread, type, product), grouping by item so ten changes to one
 * thing read as one block, and paging, because `listNotifications` used to
 * return everything the recipient had.
 *
 * Marking unread is here and not in the bell, deliberately. Opening a row is
 * how you read it, so a reader who clicks the wrong thing, or reads something
 * they cannot act on right now, needs a way to put it back; that is a
 * catching-up gesture and this is the catching-up surface.
 *
 * Filters live in component state rather than the URL. They are a reading
 * posture, not a place: nobody links somebody else to "my unread mentions", and
 * putting them in the URL would make every filter change a navigation with a
 * server round trip for a list this page already holds.
 */
export function NotificationCenter({
  initial,
  products,
}: {
  initial: NotificationList;
  products: { key: string; name: string }[];
}) {
  const router = useRouter();
  const org = useOrgSlug();

  const [items, setItems] = useState<NotificationRecord[]>(initial.items);
  const [unread, setUnread] = useState(initial.unreadCount);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [type, setType] = useState("");
  const [product, setProduct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (before?: string) => ({
      unreadOnly,
      types: type ? [type] : undefined,
      productKey: product || undefined,
      before,
    }),
    [unreadOnly, type, product],
  );

  /** Re-read from the top under the current filters. */
  const reload = useCallback(
    async (next: { unreadOnly?: boolean; type?: string; product?: string }) => {
      const filters = {
        unreadOnly: next.unreadOnly ?? unreadOnly,
        types: (next.type ?? type) ? [next.type ?? type] : undefined,
        productKey: (next.product ?? product) || undefined,
      };
      setBusy(true);
      setError(null);
      try {
        const page = await listNotifications(filters);
        setItems(page.items);
        setUnread(page.unreadCount);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load these.");
      } finally {
        setBusy(false);
      }
    },
    [unreadOnly, type, product],
  );

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const page = await listNotifications(query(cursor));
      // Appended, not replaced: this is "show me more", and the rows above are
      // where the reader has got to.
      setItems((prev) => [...prev, ...page.items]);
      setUnread(page.unreadCount);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more.");
    } finally {
      setBusy(false);
    }
  }

  function setRead(id: string, read: boolean) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read } : n)));
    setUnread((u) => Math.max(0, u + (read ? -1 : 1)));
    const call = read ? markNotificationRead : markNotificationUnread;
    // Optimistic, and corrected by a reload if the server disagrees: the cost
    // of a wrong dot for a moment is far below the cost of the list freezing
    // while somebody works through it.
    call(id).catch(() => void reload({}));
  }

  async function onMarkAll() {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await markAllNotificationsRead();
      // Under an unread-only filter the rows just stopped matching, so the list
      // has to be re-read or it would show what it says it is hiding.
      if (unreadOnly) await reload({});
    } catch {
      await reload({});
    }
  }

  function open(n: NotificationRecord) {
    if (!n.read) setRead(n.id, true);
    const base = orgProductPath(
      org,
      n.productSlug,
      `/backlog/${n.featureLevel}/${n.specId}`,
    );
    // Land on the comment when the notice came from one, so a mention does not
    // drop the reader at the top of a long spec to go looking for it.
    router.push(n.commentId ? `${base}#comment-${n.commentId}` : base);
  }

  const groups = groupNotifications(items);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {unread > 0
              ? `${unread} unread across your work.`
              : "You are up to date."}
          </p>
        </div>
        {unread > 0 ? (
          <Button variant="outline" size="sm" onClick={() => void onMarkAll()}>
            <CheckCheck aria-hidden className="h-4 w-4" />
            Mark all read
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {/* Two buttons rather than one that toggles. A single control has to
            choose between labelling the state it is in and the state it would
            move to, and either reading is wrong half the time. */}
        <div className="flex items-center gap-1">
          {([false, true] as const).map((only) => (
            <Button
              key={String(only)}
              variant={unreadOnly === only ? "default" : "outline"}
              size="sm"
              aria-pressed={unreadOnly === only}
              onClick={() => {
                if (unreadOnly === only) return;
                setUnreadOnly(only);
                void reload({ unreadOnly: only });
              }}
            >
              {only ? "Unread" : "All"}
            </Button>
          ))}
        </div>
        <Select
          aria-label="Filter by type"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            void reload({ type: e.target.value });
          }}
          className="w-56"
        >
          <option value="">Everything</option>
          {NOTIFICATION_EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {NOTIFICATION_EVENT_LABELS[t].label}
            </option>
          ))}
        </Select>
        {/* Only worth showing once there is more than one product to tell
            apart; on a single-product workspace it filters nothing. */}
        {products.length > 1 ? (
          <Select
            aria-label="Filter by product"
            value={product}
            onChange={(e) => {
              setProduct(e.target.value);
              void reload({ product: e.target.value });
            }}
            className="w-48"
          >
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center">
          <Inbox aria-hidden className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {unreadOnly || type || product
              ? "Nothing matches these filters."
              : "Nothing yet. You will hear about items assigned to you, and about the work you follow."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {groups.map((group) => (
            <li
              key={group.specId}
              className="overflow-hidden rounded-md border"
            >
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <Link
                  href={orgProductPath(
                    org,
                    group.productSlug,
                    `/backlog/${group.featureLevel}/${group.specId}`,
                  )}
                  className="truncate text-sm font-medium hover:underline"
                >
                  {group.featureTitle}
                </Link>
                {group.unreadCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-primary px-1.5 text-2xs font-medium text-primary-foreground">
                    {group.unreadCount}
                  </span>
                ) : null}
              </div>
              <ul className="divide-y">
                {group.items.map((n) => (
                  <li
                    key={n.id}
                    className={cn(
                      "flex items-start gap-2 px-3 py-2",
                      !n.read ? "bg-accent/30" : "",
                    )}
                  >
                    {/* A dot, not just a tint. The tinted row was the only
                        signal and it is nearly invisible next to a read one,
                        which makes "what have I not dealt with" a guess. */}
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        !n.read ? "bg-primary" : "bg-transparent",
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => open(n)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="sr-only">
                        {n.read ? "Read." : "Unread."}{" "}
                      </span>
                      <span className="block truncate text-sm">
                        {headline(n).actor ? (
                          <span className="font-medium">
                            {headline(n).actor}{" "}
                          </span>
                        ) : null}
                        {headline(n).text}
                      </span>
                      {n.snippet ? (
                        <span className="line-clamp-2 block text-xs text-muted-foreground">
                          {n.snippet}
                        </span>
                      ) : null}
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <time
                        className="text-2xs text-muted-foreground"
                        dateTime={n.createdAt}
                      >
                        {shortDate(n.createdAt)}
                      </time>
                      <Button
                        variant="link"
                        size="inline"
                        className="text-2xs"
                        onClick={() => setRead(n.id, !n.read)}
                      >
                        {n.read ? "Mark unread" : "Mark read"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={busy}
          >
            {busy ? "Loading…" : "Show older"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Short absolute date: the inbox is read to establish when, not how long ago. */
function shortDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
