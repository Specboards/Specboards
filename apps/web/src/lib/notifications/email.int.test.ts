import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DbStore } from "@/lib/store/db";
import { relayOutbox } from "@/lib/webhooks/relay";

/**
 * The email channel, driven through the real relay.
 *
 * What is worth asserting here is not that a message was rendered: it is who
 * does and does not receive one, which is a question the database answers. Four
 * separate things can stop a message, and each of them is somebody's explicit
 * decision that the feature exists to honour:
 *
 *   - the per-type preference (the grid's email column),
 *   - the master unsubscribe switch,
 *   - having already read the thing in the app,
 *   - the deployment having no way to send at all.
 *
 * A unit test of the renderer would have covered none of them, and getting any
 * one of them wrong means mailing somebody who has told us not to.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

/** Everything that would have reached a relay, in order. */
interface SentMail {
  to: string;
  subject: string;
  textBody: string;
  headers?: Record<string, string>;
}
const sent: SentMail[] = [];

// Stubbed at the transport, so the rendering, the subject, the recipient and
// the headers are all real. See email-change.int.test.ts for the same seam.
vi.mock("@/lib/mail/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/send")>()),
  dispatchEmail: async (message: SentMail) => {
    sent.push(message);
  },
}));

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "notif_email_int_app";
const APP_PASSWORD = "notif-email-int-only-not-a-real-secret";

const ws = randomUUID();
const user = { alice: randomUUID(), bob: randomUUID() };
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);
const BOB_EMAIL = `bob-${suffix}@notif-email.test`;

const asAlice = { userId: user.alice, workspaceId: ws };

const savedEnv = {
  from: process.env.EMAIL_FROM,
  token: process.env.POSTMARK_SERVER_TOKEN,
  appUrl: process.env.APP_URL,
  secret: process.env.BETTER_AUTH_SECRET,
};

describe.skipIf(!OWNER_URL)("notification email", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  beforeAll(async () => {
    // A transport has to resolve or the channel switches itself off, which is
    // one of the behaviours under test rather than the setup for the rest.
    process.env.EMAIL_FROM = "Specboards <no-reply@example.test>";
    process.env.POSTMARK_SERVER_TOKEN = "int-test-token";
    process.env.APP_URL = "https://app.example.test";
    process.env.BETTER_AUTH_SECRET ??=
      "notification-email-int-test-secret-value";

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
      (${ws}, 'Notify', ${"notif-email-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${suffix}@notif-email.test`}),
      (${user.bob}, 'Bob', ${BOB_EMAIL})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.alice}, 'owner'),
      (${ws}, ${user.bob}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'story', 'Stories', 0, true)`;

    const url = new URL(OWNER_URL!);
    url.username = APP_ROLE;
    url.password = APP_PASSWORD;
    store = new DbStore(url.toString());
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.alice}, ${user.bob})`;
    await owner.end({ timeout: 5 });
    for (const [k, v] of [
      ["EMAIL_FROM", savedEnv.from],
      ["POSTMARK_SERVER_TOKEN", savedEnv.token],
      ["APP_URL", savedEnv.appUrl],
      ["BETTER_AUTH_SECRET", savedEnv.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    sent.length = 0;
    await owner`delete from notifications where workspace_id = ${ws}`;
    await owner`delete from notification_preferences where workspace_id = ${ws}`;
    await owner`delete from notification_defaults where workspace_id = ${ws}`;
    await owner`update users set notification_email_opted_out_at = null
      where id = ${user.bob}`;
  });

  /** Hand Bob an item, which is the one event email is on for by default. */
  async function assignToBob(): Promise<void> {
    const item = await store.createFeature(
      { title: "Checkout flow", level: "story", productId: product },
      asAlice,
      "item.created",
    );
    await store.updateFeature(item.specId, { assigneeId: user.bob }, asAlice, [
      {
        type: "item.assigned",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          assigneeId: user.bob,
          previousAssigneeId: null,
        },
      },
    ]);
    await relayOutbox();
  }

  it("mails the person an item was handed to", async () => {
    await assignToBob();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(BOB_EMAIL);
    // The subject has to say which item, because it is read in a list of forty
    // other subjects.
    expect(sent[0]!.subject).toContain("Checkout flow");
    expect(sent[0]!.textBody).toContain("https://app.example.test/");
  });

  it("carries a one-click unsubscribe that names the recipient", async () => {
    await assignToBob();
    const headers = sent[0]!.headers ?? {};
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // The whole chain, not just the presence of a header: the URL in it has to
    // verify back to Bob, or the button in his mail client does nothing.
    const link = /<(.+?)>/.exec(headers["List-Unsubscribe"] ?? "")?.[1];
    expect(link).toBeDefined();
    const token = new URL(link!).searchParams.get("t");
    const { userIdFromUnsubscribeToken } = await import(
      "@/lib/notifications/unsubscribe"
    );
    expect(userIdFromUnsubscribeToken(token!)).toBe(user.bob);
  });

  it("sends nothing to somebody who has unsubscribed, and still fills their inbox", async () => {
    await owner`update users set notification_email_opted_out_at = now()
      where id = ${user.bob}`;
    await assignToBob();

    expect(sent).toEqual([]);
    // The switch is about email and nothing else. Losing the in-app row too
    // would make unsubscribing from mail a way to stop being told at all.
    const rows = await owner`select 1 from notifications
      where workspace_id = ${ws} and recipient_id = ${user.bob}`;
    expect(rows).toHaveLength(1);
  });

  it("sends nothing when the workspace default turns the email column off", async () => {
    await owner`insert into notification_defaults
      (workspace_id, event_type, channel, enabled)
      values (${ws}, 'item.assigned', 'email', false)`;
    await assignToBob();
    expect(sent).toEqual([]);
  });

  it("sends nothing when the person turned that row off for themselves", async () => {
    await owner`insert into notification_preferences
      (workspace_id, user_id, event_type, channel, enabled)
      values (${ws}, ${user.bob}, 'item.assigned', 'email', false)`;
    await assignToBob();
    expect(sent).toEqual([]);
  });

  it("sends nothing for a type whose email default is off", async () => {
    // A status change on an item you are assigned is in-app only out of the
    // box, because immediate mail for every stage move is the flood this
    // release exists to prevent.
    const item = await store.createFeature(
      { title: "Search ranking", level: "story", productId: product, assigneeId: user.bob },
      asAlice,
      "item.created",
    );
    await relayOutbox();
    sent.length = 0;

    await store.updateFeature(item.specId, { status: "defining" }, asAlice, [
      {
        type: "item.status_changed",
        productId: product,
        data: {
          specId: item.specId,
          title: item.title,
          level: item.level,
          from: item.status,
          to: "defining",
        },
      },
    ]);
    await relayOutbox();

    expect(sent).toEqual([]);
    const rows = await owner`select type from notifications
      where workspace_id = ${ws} and recipient_id = ${user.bob}
      order by created_at`;
    expect(rows.map((r) => r.type)).toContain("item.status_changed");
  });

  it("sends nothing at all when the deployment has no mail transport", async () => {
    const from = process.env.EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    try {
      await assignToBob();
      expect(sent).toEqual([]);
    } finally {
      process.env.EMAIL_FROM = from;
    }
  });

  /**
   * The one piece of digest-like restraint in an immediate-only channel.
   *
   * Exercised against `sendNotificationEmails` directly rather than through the
   * relay, because the window it closes is between the commit and the send and
   * cannot be widened from outside. What it asserts is the rule, not the race:
   * a notification already read is not also mailed.
   */
  it("skips a message whose notification has already been read", async () => {
    const { sendNotificationEmails } = await import("@/lib/notifications/email");
    const { getDb } = await import("@/lib/db");

    await assignToBob();
    sent.length = 0;
    const [row] = await owner<{ id: string }[]>`
      select id from notifications
      where workspace_id = ${ws} and recipient_id = ${user.bob} limit 1`;
    await owner`update notifications set read_at = now() where id = ${row!.id}`;

    const message = {
      to: BOB_EMAIL,
      subject: "Checkout flow was assigned to you",
      textBody: "body",
      htmlBody: "<p>body</p>",
      headers: {},
    };
    await sendNotificationEmails(getDb()!, [
      { notificationId: row!.id, recipientId: user.bob, message },
    ]);
    expect(sent).toEqual([]);

    // And the same message with nothing to have been read does go.
    await sendNotificationEmails(getDb()!, [
      { notificationId: null, recipientId: user.bob, message },
    ]);
    expect(sent).toHaveLength(1);
  });
});
