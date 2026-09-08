import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Reading the inbox: filters, paging, and putting something back.
 *
 * The paging is the part that fails quietly. Notifications written in one
 * transaction share `created_at` to the microsecond, so a page boundary landing
 * on a tie would drop the rest of that tie from somebody's history with nothing
 * to show it had happened. That case is built here on purpose rather than
 * waited for.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const ws = randomUUID();
const user = randomUUID();
const other = randomUUID();
const alpha = randomUUID();
const beta = randomUUID();
const suffix = randomUUID().slice(0, 8);
const scope = { userId: user, workspaceId: ws };

describe.skipIf(!OWNER_URL)("notification inbox", () => {
  let owner: postgres.Sql;
  let store: DbStore;
  let alphaItem: string;
  let betaItem: string;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);
    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'Inbox', ${"inbox-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user}, 'Alice', ${`alice-${suffix}@inbox.test`}),
      (${other}, 'Bob', ${`bob-${suffix}@inbox.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user}, 'owner'), (${ws}, ${other}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${alpha}, ${ws}, 'alpha', 'Alpha'), (${beta}, ${ws}, 'beta', 'Beta')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work Items', 0, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
    alphaItem = (
      await store.createFeature(
        { title: "Alpha item", level: "work", productId: alpha },
        scope,
      )
    ).specId;
    betaItem = (
      await store.createFeature(
        { title: "Beta item", level: "work", productId: beta },
        scope,
      )
    ).specId;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user}, ${other})`;
    await owner.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await owner`delete from notifications where workspace_id = ${ws}`;
  });

  /** Insert one notification, optionally forcing its timestamp. */
  async function notify(
    over: {
      specId?: string;
      type?: string;
      read?: boolean;
      at?: string;
      recipient?: string;
    } = {},
  ) {
    const [feature] = await owner`select id from features
      where workspace_id = ${ws} and spec_id = ${over.specId ?? alphaItem}`;
    const [row] = await owner`
      insert into notifications
        (workspace_id, recipient_id, actor_id, type, feature_id, snippet, read_at, created_at)
      values (${ws}, ${over.recipient ?? user}, ${other},
              ${over.type ?? "item.assigned"}, ${feature!.id as string}, 'something',
              ${over.read ? new Date() : null},
              ${over.at ? new Date(over.at) : new Date()})
      returning id`;
    return row!.id as string;
  }

  it("returns only the caller's own rows", async () => {
    await notify();
    await notify({ recipient: other });
    const inbox = await store.listNotifications(scope);
    expect(inbox.items).toHaveLength(1);
  });

  it("filters to unread without changing the badge count", async () => {
    await notify({ read: true });
    await notify({ read: false });
    const all = await store.listNotifications(scope);
    const unread = await store.listNotifications(scope, { unreadOnly: true });
    expect(all.items).toHaveLength(2);
    expect(unread.items).toHaveLength(1);
    // The badge is the whole inbox, not the filtered view: a count that moved
    // when somebody changed a filter would answer a question nobody asked.
    expect(unread.unreadCount).toBe(1);
    expect(all.unreadCount).toBe(1);
  });

  it("filters by type and by product", async () => {
    await notify({ type: "item.assigned", specId: alphaItem });
    await notify({ type: "comment.mentioned", specId: alphaItem });
    await notify({ type: "item.assigned", specId: betaItem });

    const mentions = await store.listNotifications(scope, {
      types: ["comment.mentioned"],
    });
    expect(mentions.items).toHaveLength(1);

    const betaOnly = await store.listNotifications(scope, {
      productKey: "beta",
    });
    expect(betaOnly.items.map((n) => n.featureTitle)).toEqual(["Beta item"]);
  });

  /**
   * The inbox is the reader's, not the product they happen to be standing in.
   * Asked without a product filter it spans the workspace, and every row names
   * the product it came from so the reader can tell one from another. Without
   * that name the surfaces read as product-scoped, which is how a notification
   * about another product comes to look like no notification at all.
   */
  it("spans every product, and says which one each row came from", async () => {
    await notify({ specId: alphaItem });
    await notify({ specId: betaItem });

    const inbox = await store.listNotifications(scope);
    expect(
      inbox.items
        .map((n) => [n.featureTitle, n.productName] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ["Alpha item", "Alpha"],
      ["Beta item", "Beta"],
    ]);
  });

  it("pages with a cursor, oldest last, without repeating a row", async () => {
    for (let i = 0; i < 5; i += 1) {
      await notify({ at: `2026-09-0${i + 1}T12:00:00.000Z` });
    }
    const first = await store.listNotifications(scope, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listNotifications(scope, {
      limit: 2,
      before: first.nextCursor!,
    });
    const seen = [...first.items, ...second.items].map((n) => n.id);
    expect(new Set(seen).size).toBe(4);
    // Newest first throughout, so paging reads as one continuous list.
    expect(first.items[0]!.createdAt > second.items[0]!.createdAt).toBe(true);
  });

  it("does not lose rows that share a timestamp across a page boundary", async () => {
    // The real shape of this: several notices written in one transaction all
    // carry that transaction's `now()`. Ordering on the timestamp alone, a
    // cursor at the boundary would skip the rest of the tie for good.
    const at = "2026-09-05T12:00:00.000Z";
    for (let i = 0; i < 4; i += 1) await notify({ at });

    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const res: Awaited<ReturnType<typeof store.listNotifications>> =
        await store.listNotifications(scope, {
          limit: 1,
          before: cursor ?? undefined,
        });
      for (const n of res.items) ids.add(n.id);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(ids.size).toBe(4);
  });

  it("stops paging at the end rather than offering a cursor to nothing", async () => {
    await notify();
    await notify();
    const page = await store.listNotifications(scope, { limit: 5 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a cursor it cannot read", async () => {
    // Starting from "now" would silently serve page one again forever.
    await expect(
      store.listNotifications(scope, { before: "not-a-date" }),
    ).rejects.toThrow();
  });

  it("marks one read, and back again", async () => {
    const id = await notify();
    await store.markNotificationRead(id, scope);
    expect((await store.listNotifications(scope)).unreadCount).toBe(0);

    await store.markNotificationUnread(id, scope);
    const back = await store.listNotifications(scope);
    expect(back.unreadCount).toBe(1);
    expect(back.items[0]!.read).toBe(false);
  });

  it("will not let one person mark another's notification unread", async () => {
    const id = await notify({ recipient: other, read: true });
    await store.markNotificationUnread(id, scope);
    const [row] =
      await owner`select read_at from notifications where id = ${id}`;
    expect(row!.read_at).not.toBeNull();
  });
});
