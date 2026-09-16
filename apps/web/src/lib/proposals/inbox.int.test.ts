import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@specboards/db";

/**
 * What the review queue shows, and to whom.
 *
 * The visibility half is the one worth a real database. `listReviewQueue`
 * writes no product filter of its own and leans entirely on the row-level
 * security policies, which resolve the proposal's real target rather than
 * trusting its denormalised `product_id`. That distinction is not academic:
 * `specboards_can_read_product(ws, NULL)` is true for every member, so a
 * hand-written filter on `product_id` would be no filter at all for a row
 * whose `product_id` happened to be null. A unit test with a fake store
 * would assert the filter that is deliberately not there.
 *
 * ── The connection matters more than the assertions ─────────────────────
 * The code under test runs on a NON-OWNER role here, provisioned the way
 * `infra/rls-role.sql` does it and the way `rls-isolation.int.test.ts`
 * already does for the same reason. The first version of this file used the
 * owner connection, which bypasses row-level security entirely: every
 * negative assertion below passed a row it should have refused, and had the
 * positive cases been the only ones written, the queue would have shipped
 * with its access control never once exercised. `the harness itself` at the
 * bottom is what stops that coming back.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "reviews_int_app";
const APP_PASSWORD = "reviews-int-only-not-a-real-secret";

/** The same connection string, as the non-owner application role. */
function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
/** Workspace owner: an org admin, so every product is readable. */
const owner = randomUUID();
/** An ordinary member, invited to the open product only. */
const insider = randomUUID();
/** An ordinary member invited to nothing. */
const outsider = randomUUID();
const agent = randomUUID();

const openProduct = randomUUID();
const closedProduct = randomUUID();
const runId = randomUUID();

const asOwner = { userId: owner, workspaceId: ws };
const asInsider = { userId: insider, workspaceId: ws };
const asOutsider = { userId: outsider, workspaceId: ws };

describe.skipIf(!OWNER_URL)("the review queue", () => {
  let sql: postgres.Sql;
  let db: Database;
  let inbox: typeof import("./inbox");
  /** The same client as `db`, kept so the harness test can ask its role. */
  let createdDb: Database;
  let openItem: string;
  let closedItem: string;

  beforeAll(async () => {
    // Fixtures are written as the owner; the queue is read as the app role.
    sql = postgres(OWNER_URL!, { prepare: false, max: 4 });
    await sql.unsafe(`
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
    const { createDb } = await import("@specboards/db");
    db = createDb(appUrlFrom(OWNER_URL!));
    createdDb = db;
    inbox = await import("./inbox");

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Reviews', ${"rev-int-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@rev.test`}),
      (${insider}, 'Insider', ${`in-${sfx}@rev.test`}),
      (${outsider}, 'Outsider', ${`out-${sfx}@rev.test`}),
      (${agent}, 'Scout', ${`scout-${sfx}@rev.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'),
      (${ws}, ${insider}, 'member'),
      (${ws}, ${outsider}, 'member'),
      (${ws}, ${agent}, 'service')`;
    // One product everybody in the workspace can read, one that needs an
    // invitation. The whole test rests on the difference.
    await sql`insert into products (id, workspace_id, key, name, visibility) values
      (${openProduct}, ${ws}, 'open', 'Open', 'org'),
      (${closedProduct}, ${ws}, 'closed', 'Closed', 'private')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work Items', 0, true)`;
    await sql`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${openProduct}, ${insider}, 'contributor')`;

    openItem = randomUUID();
    closedItem = randomUUID();
    await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status) values
      (${openItem}, ${ws}, ${openProduct}, ${openItem}, 'work', 'Open item', 'backlog'),
      (${closedItem}, ${ws}, ${closedProduct}, ${closedItem}, 'work', 'Closed item', 'backlog')`;
    await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                      target_id, agent_id, actor_type, trigger,
                                      status, finished_at)
      values (${runId}, ${ws}, ${openProduct}, 'feature', ${openItem},
              ${agent}, 'agent', 'assignment', 'succeeded', now())`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${insider}, ${outsider}, ${agent})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`delete from agent_runs where workspace_id = ${ws} and id <> ${runId}`;
  });

  /**
   * A run proposal against one item.
   *
   * `productId` is passed separately from the target on purpose, so a test
   * can write the mismatch the RLS policy exists to survive: a row whose
   * denormalised product says one thing and whose real target says another.
   */
  async function propose(
    targetId: string,
    productId: string | null,
    opts: { origin?: "run" | "conversation"; status?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql`insert into proposals
        (id, workspace_id, product_id, origin, run_id, actor_id, actor_type,
         kind, target_type, target_id, payload, status, resolved_at)
      values (${id}, ${ws}, ${productId}, ${opts.origin ?? "run"}, ${runId},
              ${agent}, 'agent', 'item_metadata', 'feature', ${targetId},
              ${sql.json({ status: "ready" })}, ${opts.status ?? "open"},
              ${opts.status && opts.status !== "open" ? new Date() : null})`;
    return id;
  }

  const idsFor = async (scope: typeof asOwner) =>
    (await inbox.listReviewQueue(db, scope)).map((r) => r.id);

  describe("the harness itself", () => {
    it("reads as a role that row-level security actually applies to", async () => {
      // Without this, every negative assertion in this file is vacuous. The
      // owner role bypasses RLS, so a queue with no access control at all
      // would pass the visibility tests below. Asserting both halves, rather
      // than just "not the owner", also proves the fixture is one the
      // policies genuinely exclude somebody from.
      const id = await propose(closedItem, closedProduct);

      const [who] = await (
        createdDb as unknown as { $client: postgres.Sql }
      ).$client<{ role: string }[]>`select current_user as role`;
      expect(who!.role).toBe(APP_ROLE);

      const asOwnerRole = postgres(OWNER_URL!, { prepare: false, max: 1 });
      try {
        const rows = await asOwnerRole`
          select id from proposals where id = ${id}`;
        expect(rows).toHaveLength(1); // the row is really there
      } finally {
        await asOwnerRole.end({ timeout: 5 });
      }
      // ...and the connection under test cannot see it.
      expect(await idsFor(asOutsider)).not.toContain(id);
    });
  });

  describe("who sees what", () => {
    it("shows a proposal to a member who can read its product", async () => {
      const id = await propose(openItem, openProduct);
      expect(await idsFor(asInsider)).toContain(id);
      expect(await idsFor(asOwner)).toContain(id);
    });

    it("hides a proposal whose product the member was never invited to", async () => {
      const id = await propose(closedItem, closedProduct);
      expect(await idsFor(asInsider)).not.toContain(id);
      expect(await idsFor(asOutsider)).not.toContain(id);
      // Visible to the org admin, so the absence above is about access and
      // not about the row being unreadable by everyone.
      expect(await idsFor(asOwner)).toContain(id);
    });

    it("still hides it when the row's own product_id says otherwise", async () => {
      // The case the policy is written for. `product_id` here is a routing
      // snapshot, and a null one reads as "no product", which every member
      // can read. If the queue trusted this column instead of the target,
      // this proposal against a private item would be visible to everybody.
      const lying = await propose(closedItem, null);
      const alsoLying = await propose(closedItem, openProduct);
      const seen = await idsFor(asOutsider);
      expect(seen).not.toContain(lying);
      expect(seen).not.toContain(alsoLying);
    });
  });

  describe("what belongs in the queue", () => {
    it("leaves conversation proposals out of it", async () => {
      // They already have a reviewer, sitting in front of them. This is the
      // reason `origin` is a column at all.
      const conversational = randomUUID();
      await sql`insert into assistant_messages
          (id, workspace_id, feature_id, role, content, author_id)
        values (${conversational}, ${ws}, ${openItem}, 'assistant', 'hi', ${agent})`;
      const id = randomUUID();
      await sql`insert into proposals
          (id, workspace_id, product_id, origin, source_message_id, actor_id,
           actor_type, kind, target_type, target_id, payload, status)
        values (${id}, ${ws}, ${openProduct}, 'conversation', ${conversational},
                ${agent}, 'agent', 'item_metadata', 'feature', ${openItem},
                ${sql.json({ status: "ready" })}, 'open')`;
      expect(await idsFor(asOwner)).not.toContain(id);
    });

    it("leaves a proposal somebody already decided about out of it", async () => {
      const settled = await propose(openItem, openProduct, { status: "dismissed" });
      const open = await propose(openItem, openProduct);
      const seen = await idsFor(asOwner);
      expect(seen).not.toContain(settled);
      expect(seen).toContain(open);
    });

    it("includes a run that stopped to ask something", async () => {
      const stalled = randomUUID();
      await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                        target_id, agent_id, actor_type, trigger,
                                        status, summary)
        values (${stalled}, ${ws}, ${openProduct}, 'feature', ${openItem},
                ${agent}, 'agent', 'assignment', 'awaiting_input',
                'Which of the two pricing pages did you mean?')`;
      const row = (await inbox.listReviewQueue(db, asOwner)).find(
        (r) => r.id === stalled,
      );
      expect(row?.kind).toBe("awaiting_run");
      expect(row?.summary).toContain("pricing pages");
    });

    it("hides a stalled run on a product the member cannot read", async () => {
      const stalled = randomUUID();
      await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                        target_id, agent_id, actor_type, trigger,
                                        status, summary)
        values (${stalled}, ${ws}, ${closedProduct}, 'feature', ${closedItem},
                ${agent}, 'agent', 'assignment', 'awaiting_input', 'Well?')`;
      expect(await idsFor(asOutsider)).not.toContain(stalled);
      expect(await idsFor(asOwner)).toContain(stalled);
    });

    it("leaves a run that is merely running out of it", async () => {
      const working = randomUUID();
      await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                        target_id, agent_id, actor_type, trigger, status)
        values (${working}, ${ws}, ${openProduct}, 'feature', ${openItem},
                ${agent}, 'agent', 'assignment', 'running')`;
      expect(await idsFor(asOwner)).not.toContain(working);
    });
  });

  describe("what a row carries", () => {
    it("names the target, the agent and where to act", async () => {
      const id = await propose(openItem, openProduct);
      const row = (await inbox.listReviewQueue(db, asOwner)).find(
        (r) => r.id === id,
      );
      expect(row).toMatchObject({
        kind: "proposal",
        proposalKind: "item_metadata",
        targetTitle: "Open item",
        actorName: "Scout",
        // The apply endpoint is addressed by specId, not by the row id the
        // proposal stores, so the queue has to resolve it or the row cannot
        // be acted on.
        targetRef: openItem,
      });
    });

    it("puts the newest first, across both kinds of row", async () => {
      const older = await propose(openItem, openProduct);
      await new Promise((r) => setTimeout(r, 10));
      const stalled = randomUUID();
      await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                        target_id, agent_id, actor_type, trigger, status)
        values (${stalled}, ${ws}, ${openProduct}, 'feature', ${openItem},
                ${agent}, 'agent', 'assignment', 'awaiting_input')`;
      await new Promise((r) => setTimeout(r, 10));
      const newest = await propose(openItem, openProduct);

      expect(await idsFor(asOwner)).toEqual([newest, stalled, older]);
    });

    it("honours a limit without letting one kind crowd out the other", async () => {
      // Two proposals newer than the stalled run, asked for two rows: the
      // naive "split the limit" would return one of each and drop a newer
      // proposal for an older run.
      const stalled = randomUUID();
      await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                        target_id, agent_id, actor_type, trigger, status)
        values (${stalled}, ${ws}, ${openProduct}, 'feature', ${openItem},
                ${agent}, 'agent', 'assignment', 'awaiting_input')`;
      await new Promise((r) => setTimeout(r, 10));
      const a = await propose(openItem, openProduct);
      const b = await propose(openItem, openProduct);

      const rows = await inbox.listReviewQueue(db, asOwner, { limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    });
  });
});
