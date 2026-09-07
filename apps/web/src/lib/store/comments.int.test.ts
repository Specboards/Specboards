import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { CommentError } from "./types";

/**
 * Comments store integration suite: exercises listComments/createComment/
 * deleteComment against a migrated Postgres with RLS active, via a non-owner
 * app role (same provisioning as releases.int.test.ts).
 *
 * Covers: a member can comment on an item they can read and it lists back with
 * the author resolved; another member sees it; only the author or the workspace
 * owner can delete a comment; empty bodies and unknown items are rejected.
 *
 * Posting a comment no longer writes anybody's notification rows: it records a
 * `comment.created` outbox event, and the fan-out decides who hears about it.
 * So what this suite asserts about mentions is that the *event* carries what
 * the fan-out needs. Who actually receives one, and as which type, belongs to
 * notifications/fanout.int.test.ts, which drives the relay.
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
const user = {
  owner: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
};
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asAlice = { userId: user.alice, workspaceId: ws };
const asBob = { userId: user.bob, workspaceId: ws };

describe.skipIf(!OWNER_URL)("comments (store + RLS)", () => {
  let owner: postgres.Sql;
  let store: DbStore;
  let specId: string;

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
      (${ws}, 'Comments', ${"cmt-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@cmt.test`}),
      (${user.alice}, 'Alice', ${`alice-${suffix}@cmt.test`}),
      (${user.bob}, 'Bob', ${`bob-${suffix}@cmt.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.alice}, 'member'),
      (${ws}, ${user.bob}, 'member')`;
    // Org-visible product so every member can read (and thus comment on) it.
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));

    const feature = await store.createFeature(
      { title: "Commentable epic", level: "epic", productId: product },
      asOwner,
    );
    specId = feature.specId;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.alice}, ${user.bob})`;
    await owner.end({ timeout: 5 });
  });

  it("lets a member comment and resolves the author for display", async () => {
    const created = await store.createComment(
      specId,
      { body: "  first!  " },
      asAlice,
    );
    expect(created.body).toBe("first!"); // trimmed
    expect(created.authorId).toBe(user.alice);
    expect(created.authorName).toBe("Alice");

    // Another member sees it in the list.
    const list = await store.listComments(specId, asBob);
    expect(list).toHaveLength(1);
    expect(list[0]!.authorName).toBe("Alice");
    expect(list[0]!.body).toBe("first!");
  });

  it("rejects an empty comment body", async () => {
    await expect(
      store.createComment(specId, { body: "   " }, asAlice),
    ).rejects.toThrow(CommentError);
  });

  it("rejects commenting on / listing an unknown item", async () => {
    await expect(store.listComments(randomUUID(), asAlice)).rejects.toThrow(
      CommentError,
    );
    await expect(
      store.createComment(randomUUID(), { body: "hi" }, asAlice),
    ).rejects.toThrow(CommentError);
  });

  it("records the comment as an event carrying everything the fan-out needs", async () => {
    const created = await store.createComment(
      specId,
      { body: "hey @Bob and @Alice", mentionedUserIds: [user.bob, user.alice] },
      asAlice,
    );

    const [event] = await owner`select type, actor_id, data from outbox_events
      where workspace_id = ${ws} and type = 'comment.created'
      order by created_at desc limit 1`;
    const data = event!.data as Record<string, unknown>;
    // The item and the comment, so the notice can deep-link to the thread;
    // the snippet, so the inbox row reads without loading the comment; the
    // mention list, so a mention can be told apart from an update.
    expect(data).toMatchObject({
      specId,
      commentId: created.id,
      mentionedUserIds: [user.bob, user.alice],
    });
    expect(String(data.snippet)).toContain("hey @Bob");
    // The author is the actor, which is what lets the fan-out drop Alice from
    // her own mention rather than each write site remembering to.
    expect(event!.actor_id).toBe(user.alice);
  });

  it("de-dupes a repeated mention in the event itself", async () => {
    // Cheaper here than in the fan-out, and it means the event is a clean
    // record of who was named rather than of how many times the name appeared.
    await store.createComment(
      specId,
      {
        body: "@Bob @Bob @Bob",
        mentionedUserIds: [user.bob, user.bob, user.bob],
      },
      asAlice,
    );

    const [event] = await owner`select data from outbox_events
      where workspace_id = ${ws} and type = 'comment.created'
      order by created_at desc limit 1`;
    expect((event!.data as { mentionedUserIds: string[] }).mentionedUserIds).toEqual(
      [user.bob],
    );
  });

  it("writes no notification rows of its own", async () => {
    // The whole point of the move: one place decides recipients. A row
    // appearing here would mean two answers to "who should be told", and the
    // preference layer only filters one of them.
    await owner`delete from notifications where workspace_id = ${ws}`;
    await store.createComment(
      specId,
      { body: "@Bob look", mentionedUserIds: [user.bob] },
      asAlice,
    );
    const [n] = await owner`select count(*)::int as n from notifications
      where workspace_id = ${ws}`;
    expect(n!.n).toBe(0);
  });

  it("lets only the author or the owner delete a comment", async () => {
    const c = await store.createComment(specId, { body: "delete me" }, asAlice);

    // A different member (not author, not owner) cannot delete it.
    await expect(store.deleteComment(c.id, asBob)).rejects.toThrow(
      CommentError,
    );

    // The workspace owner can delete anyone's comment.
    await store.deleteComment(c.id, asOwner);
    const remaining = await store.listComments(specId, asAlice);
    expect(remaining.some((x) => x.id === c.id)).toBe(false);

    // The author can delete their own.
    const own = await store.createComment(specId, { body: "mine" }, asBob);
    await store.deleteComment(own.id, asBob);
  });

  it("lists a recipient's notifications, resolves the target, and marks read", async () => {
    // Seeded directly rather than through a comment: the reading side is what
    // is under test, and having it depend on what earlier cases happened to
    // leave behind made a failure here point at the wrong feature.
    await owner`delete from notifications where workspace_id = ${ws}`;
    const [feature] = await owner`select id from features
      where workspace_id = ${ws} and spec_id = ${specId}`;
    for (const snippet of ["first mention", "second mention"]) {
      await owner`insert into notifications
        (workspace_id, recipient_id, actor_id, type, feature_id, snippet)
        values (${ws}, ${user.bob}, ${user.alice}, 'comment.mentioned',
                ${feature!.id as string}, ${snippet})`;
    }

    const before = await store.listNotifications(asBob);
    expect(before.unreadCount).toBe(2);
    expect(before.items.length).toBe(before.unreadCount);
    // Each resolves to the source item + a mention type for deep-linking.
    expect(before.items.every((n) => n.type === "comment.mentioned")).toBe(true);
    expect(before.items.every((n) => n.specId === specId)).toBe(true);
    expect(before.items.every((n) => n.actorName === "Alice")).toBe(true);

    // Marking one read drops the unread count by exactly one.
    const first = before.items.find((n) => !n.read)!;
    await store.markNotificationRead(first.id, asBob);
    const mid = await store.listNotifications(asBob);
    expect(mid.unreadCount).toBe(before.unreadCount - 1);

    // Mark-all clears the badge and flags every row read.
    await store.markAllNotificationsRead(asBob);
    const after = await store.listNotifications(asBob);
    expect(after.unreadCount).toBe(0);
    expect(after.items.every((n) => n.read)).toBe(true);
  });

  it("scopes the inbox to the recipient (the author sees none of them)", async () => {
    // Alice only ever authored the mentions, so she is never a recipient.
    const alice = await store.listNotifications(asAlice);
    expect(alice.items).toHaveLength(0);
    expect(alice.unreadCount).toBe(0);
  });
});
