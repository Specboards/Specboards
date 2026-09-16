import { randomUUID } from "node:crypto";

import { createDb } from "@specboards/db";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asUser } from "@/lib/db-scope";
import { insertProposal } from "@/lib/proposals/store";
import { DbStore } from "@/lib/store/db";
import { relayOutbox } from "@/lib/webhooks/relay";

/**
 * Who hears that an agent has proposed something.
 *
 * The review queue shipped in v1.3.0 with a Reviews entry in the primary
 * navigation, which answers discoverability for somebody already in the app.
 * This is the answer for somebody who is not, and it matters exactly when
 * agents start producing proposals on their own schedule rather than while a
 * person is watching.
 *
 * ── Why this is an integration test ─────────────────────────────────────────
 * Every claim below is a database question. Who is following the item, whether
 * the drafting agent is filtered out, whether a row survives its target being
 * deleted: none of it is visible in a unit test of the resolver, and the last
 * one is decided by a foreign key rather than by any code at all.
 *
 * Driven through the real relay, so what is covered is the property that
 * matters: the proposal and the intent to notify commit together, and the
 * event is expanded once.
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

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const product = randomUUID();
const user = {
  alice: randomUUID(), // owner, watching the item
  bob: randomUUID(), // member, assigned the item
  carol: randomUUID(), // member, following nothing: the control
  agent: randomUUID(), // the service account drafting proposals
};

interface InboxRow {
  recipient_id: string;
  type: string;
  snippet: string;
  actor_id: string | null;
}

describe.skipIf(!OWNER_URL)("a proposal opening", () => {
  let owner: postgres.Sql;
  let store: DbStore;
  let appDb: ReturnType<typeof createDb>;
  let itemId: string;
  let runId: string;

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
      (${ws}, 'Proposals', ${"prop-notif-" + sfx})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${sfx}@prop.test`}),
      (${user.bob}, 'Bob', ${`bob-${sfx}@prop.test`}),
      (${user.carol}, 'Carol', ${`carol-${sfx}@prop.test`}),
      (${user.agent}, 'Reviewer bot', ${`bot-${sfx}@prop.test`})`;
    // The agent is a member with role 'service', which is what the fan-out's
    // `activeMembers` filters on. A plain member row here would make the
    // "never tells the agent" test pass for the wrong reason.
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.alice}, 'owner'),
      (${ws}, ${user.bob}, 'member'),
      (${ws}, ${user.carol}, 'member'),
      (${ws}, ${user.agent}, 'service')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epics', 0, false),
             (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
    appDb = createDb(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${user.alice}, ${user.bob}, ${user.carol}, ${user.agent})`;
    await owner.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await owner`delete from proposals where workspace_id = ${ws}`;
    await owner`delete from agent_runs where workspace_id = ${ws}`;
    await owner`delete from features where workspace_id = ${ws}`;
    await owner`delete from notifications where workspace_id = ${ws}`;
    await owner`delete from outbox_events where workspace_id = ${ws}`;
    await owner`delete from notification_preferences where workspace_id = ${ws}`;

    // Bob is assigned, so he follows by inference; Alice watches explicitly.
    // Carol follows nothing, and proves the notice goes to followers rather
    // than to the workspace.
    itemId = randomUUID();
    await owner`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, assignee_id)
      values (${itemId}, ${ws}, ${product}, ${randomUUID()}, 'story',
              'Checkout flow', 'backlog', ${user.bob})`;
    await owner`insert into item_watchers
      (workspace_id, feature_id, user_id, watching, source)
      values (${ws}, ${itemId}, ${user.alice}, true, 'manual')`;

    runId = randomUUID();
    await owner`insert into agent_runs
      (id, workspace_id, product_id, target_type, target_id, agent_id,
       actor_type, trigger, status)
      values (${runId}, ${ws}, ${product}, 'feature', ${itemId}, ${user.agent},
              'agent', 'assignment', 'running')`;
  });

  /**
   * Relay the outbox, then answer both halves of "who was told": what the
   * fan-out wrote, and what each recipient can actually read.
   *
   * Same argument `fanout.int.test.ts` makes at length. Rows are written by
   * the worker under a permissive policy and read by the app under a
   * restrictive one, so a row that exists and cannot be read is a notification
   * that silently does not exist. Only comparing the two catches it, and the
   * "tells nobody" assertions need the owner connection anyway to tell "no row
   * was written" from "a row was written and the policy hides it".
   */
  async function drain(): Promise<InboxRow[]> {
    await relayOutbox();
    const written = await owner<InboxRow[]>`
      select recipient_id, type, snippet, actor_id
      from notifications
      where workspace_id = ${ws}
      order by created_at, type`;

    const readable: InboxRow[] = [];
    for (const recipientId of Object.values(user)) {
      const inbox = await store.listNotifications({
        userId: recipientId,
        workspaceId: ws,
      });
      for (const n of inbox.items) {
        readable.push({
          recipient_id: recipientId,
          type: n.type,
          snippet: n.snippet,
          actor_id: n.actorId,
        });
      }
    }
    expect(
      canonical(readable),
      "the recipients cannot read what the fan-out wrote",
    ).toEqual(canonical(written));
    return written;
  }

  /** Order-free comparable form: the two readers sort differently on purpose. */
  function canonical(rows: readonly InboxRow[]): string[] {
    return rows
      .map((r) => [r.recipient_id, r.type, r.snippet, r.actor_id].join("|"))
      .sort();
  }

  /** Draft a proposal the way an agent finishing a run does. */
  function draft(over: Record<string, unknown> = {}) {
    return asUser(appDb, user.agent, (tx) =>
      insertProposal(tx, {
        workspaceId: ws,
        productId: product,
        origin: "run",
        runId,
        actorId: user.agent,
        actorType: "agent",
        kind: "item_metadata",
        targetType: "feature",
        targetId: itemId,
        payload: { status: "ready" },
        baseVersion: null,
        ...over,
      }),
    );
  }

  it("tells the people following the item, once each", async () => {
    await draft();
    const rows = await drain();

    expect(rows.map((r) => r.recipient_id).sort()).toEqual(
      [user.alice, user.bob].sort(),
    );
    expect(rows.every((r) => r.type === "proposal.opened")).toBe(true);
    // The row has to say which item: the reader is deciding whether this is
    // worth opening now, against everything else in the bell.
    expect(rows[0]!.snippet).toContain("Checkout flow");
  });

  it("never tells the agent that drafted it, even when the item is its own", async () => {
    // The agent is assigned and watching here, so it would be a recipient but
    // for the actor subtraction and the service-role filter. Neither is a rule
    // written for proposals, and this pins that no such rule is needed.
    await owner`update features set assignee_id = ${user.agent} where id = ${itemId}`;
    await owner`insert into item_watchers
      (workspace_id, feature_id, user_id, watching, source)
      values (${ws}, ${itemId}, ${user.agent}, true, 'manual')`;

    await draft();
    const rows = await drain();
    expect(rows.map((r) => r.recipient_id)).not.toContain(user.agent);
  });

  it("tells nobody about a conversation proposal", async () => {
    // The person who asked is sitting in front of the thread it appeared in.
    const messageId = await seedConversationMessage();
    await draft({
      origin: "conversation",
      runId: null,
      sourceMessageId: messageId,
      actorId: user.alice,
      actorType: "user",
    });
    expect(await drain()).toEqual([]);
  });

  it("tells nobody about a proposal materialised already decided", async () => {
    // The legacy carry-across path. Announcing a decision somebody made long
    // before this table existed would be worse than saying nothing.
    await draft({
      status: "dismissed",
      resolvedBy: user.alice,
      resolvedAt: new Date(),
    });
    expect(await drain()).toEqual([]);
  });

  it("tells nobody when the proposal targets something that is not an item", async () => {
    // `notifications.feature_id` is NOT NULL, so a release-targeted proposal
    // has nowhere to land. Left out rather than half-built, the same answer
    // `item.deleted` gets. The outbox row still exists for webhook consumers,
    // whose delivery rows have no such column.
    const releaseId = randomUUID();
    await owner`insert into releases (id, workspace_id, name, status)
      values (${releaseId}, ${ws}, 'v9', 'planned')`;
    await draft({ targetType: "release", targetId: releaseId });

    expect(await drain()).toEqual([]);
    const events = await owner<{ type: string }[]>`
      select type from outbox_events where workspace_id = ${ws}`;
    expect(
      events.map((e) => e.type),
      "the event is still emitted for webhook subscribers",
    ).toEqual(["proposal.opened"]);
  });

  it("leaves no link to nothing when the target is deleted first", async () => {
    // `notifications.feature_id` is NOT NULL ON DELETE CASCADE, so the row
    // either never inserts or is cascaded away with its item. Both are the
    // right answer; a row pointing at a missing item is not.
    await draft();
    await owner`delete from features where id = ${itemId}`;

    expect(await drain()).toEqual([]);
    const [orphan] = await owner<{ n: string }[]>`
      select count(*) as n from notifications n
      where n.workspace_id = ${ws}
        and not exists (select 1 from features f where f.id = n.feature_id)`;
    expect(Number(orphan!.n)).toBe(0);
  });

  it("respects a recipient who has muted the item", async () => {
    // The per-item mute is the only per-item lever there is, and an agent
    // working to a schedule is exactly what somebody would reach for it over.
    await owner`update item_watchers set watching = false
      where feature_id = ${itemId} and user_id = ${user.alice}`;
    await draft();
    const rows = await drain();
    expect(rows.map((r) => r.recipient_id)).toEqual([user.bob]);
  });

  it("respects a recipient who has switched the type off", async () => {
    // One row per channel: the grid is per (type, channel), which is what
    // lets somebody keep the bell and drop the mail.
    await owner`insert into notification_preferences
      (workspace_id, user_id, event_type, channel, enabled)
      values (${ws}, ${user.bob}, 'proposal.opened', 'in_app', false),
             (${ws}, ${user.bob}, 'proposal.opened', 'email', false)`;
    await draft();
    const rows = await drain();
    expect(rows.map((r) => r.recipient_id)).toEqual([user.alice]);
  });

  /** A conversation proposal needs the assistant turn it hangs off. */
  async function seedConversationMessage(): Promise<string> {
    const messageId = randomUUID();
    await owner`insert into assistant_messages
      (id, workspace_id, feature_id, role, content, author_id)
      values (${messageId}, ${ws}, ${itemId}, 'assistant', 'Here you go',
              ${user.alice})`;
    return messageId;
  }
});
