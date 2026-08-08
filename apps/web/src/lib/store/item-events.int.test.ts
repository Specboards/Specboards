import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * The item change ledger, against a migrated Postgres with RLS active via a
 * non-owner app role (same provisioning as the other store suites).
 *
 * What is asserted here is what a change log and a revert actually need, which
 * is more than "a row appeared":
 *
 * - the value a field held *before* the change, since that is knowable only at
 *   write time and no later feature can reconstruct it
 * - who made it, and whether that was a person or an automation, since
 *   reporting that cannot tell those apart cannot answer "what did the team
 *   change this month"
 * - that a write which changes nothing records nothing, or the history fills
 *   with noise and stops being readable
 * - that history is genuinely append-only, enforced by the database rather than
 *   by everyone remembering
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
const user = { owner: randomUUID(), mate: randomUUID() };
const product = { alpha: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
/** The same person, reaching us through an MCP agent's API key. */
const asAgent = {
  userId: user.owner,
  workspaceId: ws,
  actor: { type: "api_key" as const, id: user.owner, label: "Release bot" },
};

describe.skipIf(!OWNER_URL)("item change ledger", () => {
  let owner: postgres.Sql;
  let store: DbStore;

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
      (${ws}, 'Ledger', ${"ledger-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@ledger.test`}),
      (${user.mate}, 'Mate', ${`mate-${suffix}@ledger.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.mate}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.mate})`;
    await owner.end({ timeout: 5 });
  });

  async function newItem(title: string) {
    return store.createFeature(
      { title, level: "story", productId: product.alpha },
      asOwner,
    );
  }

  it("records what a field was before, not just that it changed", async () => {
    const item = await newItem("Ledger: status");
    await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);

    const events = await store.listItemEvents(item.specId, asOwner);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.field_changed",
      field: "status",
      after: "in_progress",
      actorType: "user",
      actorId: user.owner,
    });
    // The point of the whole table. Without the previous value this is an
    // activity feed, and revert is impossible.
    expect(events[0]!.before).toBe(item.status);
  });

  it("writes one row per field, so each can be reverted on its own", async () => {
    const item = await newItem("Ledger: multi");
    await store.updateFeature(
      item.specId,
      { status: "in_progress", assigneeId: user.mate },
      asOwner,
    );

    const events = await store.listItemEvents(item.specId, asOwner);
    expect(events.map((e) => e.field).sort()).toEqual(["assigneeId", "status"]);
  });

  it("records nothing when a write changes nothing", async () => {
    const item = await newItem("Ledger: no-op");
    // Re-saving a form with untouched values, including a list that is equal
    // but not identical. Logging these would bury the real changes.
    await store.updateFeature(
      item.specId,
      { title: "Ledger: no-op", status: item.status, tags: [...item.tags] },
      asOwner,
    );
    expect(await store.listItemEvents(item.specId, asOwner)).toHaveLength(0);
  });

  it("tells an automation apart from the person it acts for", async () => {
    const item = await newItem("Ledger: actor");
    await store.updateFeature(item.specId, { status: "in_progress" }, asAgent);

    const [event] = await store.listItemEvents(item.specId, asOwner);
    // Attributable to the key's owner, and still not a person typing. Both
    // facts are needed, and neither can be added to this row later.
    expect(event).toMatchObject({
      actorType: "api_key",
      actorId: user.owner,
      actorLabel: "Release bot",
    });
  });

  it("keeps a value that was cleared distinguishable from one never set", async () => {
    const item = await newItem("Ledger: clearing");
    await store.updateFeature(item.specId, { assigneeId: user.mate }, asOwner);
    await store.updateFeature(item.specId, { assigneeId: null }, asOwner);

    const events = await store.listItemEvents(item.specId, asOwner);
    expect(events).toHaveLength(2);
    // Newest first: the clear, then the assignment it undid.
    expect(events[0]).toMatchObject({ before: user.mate, after: null });
    expect(events[1]).toMatchObject({ before: null, after: user.mate });
  });

  it("returns the history newest first", async () => {
    const item = await newItem("Ledger: order");
    await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);
    await store.updateFeature(item.specId, { title: "Ledger: renamed" }, asOwner);

    const events = await store.listItemEvents(item.specId, asOwner);
    expect(events.map((e) => e.field)).toEqual(["title", "status"]);
  });

  it("refuses to let history be rewritten", async () => {
    const item = await newItem("Ledger: immutable");
    await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);
    const [event] = await store.listItemEvents(item.specId, asOwner);

    // A revert must be a new forward event. History that can be edited is
    // worthless to anyone who wants this for compliance, so the guarantee is
    // in the database rather than in everyone's good intentions.
    await expect(
      owner`update item_events set after = '"backlog"'::jsonb where id = ${event!.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it("does not hand one workspace's history to another", async () => {
    const item = await newItem("Ledger: tenancy");
    await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);

    const stranger = { userId: randomUUID(), workspaceId: randomUUID() };
    expect(await store.listItemEvents(item.specId, stranger)).toEqual([]);
  });
  describe("activity reporting", () => {
    const WIDE = { from: "2000-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z" };

    it("says when history begins, so a quiet window is not read as quiet work", async () => {
      const item = await newItem("Report: since");
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);

      const summary = await store.itemActivitySummary(WIDE, asOwner);
      // The ledger starts when it was deployed. A report that omits this makes
      // a period of no *recording* look like a period of no *work*.
      expect(summary.since).not.toBeNull();
      expect(new Date(summary.since!).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("counts nothing outside the window it was asked about", async () => {
      const item = await newItem("Report: window");
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);

      const past = await store.itemActivitySummary(
        { from: "2000-01-01T00:00:00.000Z", to: "2000-02-01T00:00:00.000Z" },
        asOwner,
      );
      expect(past.total).toBe(0);
      expect(past.byActor).toEqual([]);
      // `since` still reports, because it is a property of the ledger rather
      // than of the window, and it is what explains an empty window.
      expect(past.since).not.toBeNull();
    });

    it("separates people from automations", async () => {
      const item = await newItem("Report: actors");
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);
      await store.updateFeature(item.specId, { assigneeId: user.mate }, asAgent);

      const summary = await store.itemActivitySummary(WIDE, asOwner);
      const kinds = summary.byActor.map((a) => a.actorType);
      // The question the actor model exists to answer. If these collapsed into
      // one bucket, "what did the team change" would silently include the bots.
      expect(kinds).toContain("user");
      expect(kinds).toContain("api_key");
    });

    it("groups by what changed", async () => {
      const item = await newItem("Report: fields");
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);
      await store.updateFeature(item.specId, { title: "Report: renamed" }, asOwner);

      const summary = await store.itemActivitySummary(WIDE, asOwner);
      const fields = summary.byField.map((f) => f.field);
      expect(fields).toContain("status");
      expect(fields).toContain("title");
    });

    it("measures a stage only when both ends of it were recorded", async () => {
      const item = await newItem("Report: stage time");
      // One status change: we know when it left this stage, but not when it
      // entered, so there is no completed span to average yet.
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);
      const first = await store.itemActivitySummary(WIDE, asOwner);
      expect(first.stageTime.find((s) => s.status === "backlog")).toBeUndefined();

      // A second change closes the span for the stage in between.
      await store.updateFeature(item.specId, { status: "in_review" }, asOwner);
      const second = await store.itemActivitySummary(WIDE, asOwner);
      const inProgress = second.stageTime.find((s) => s.status === "in_progress");
      expect(inProgress?.samples).toBeGreaterThanOrEqual(1);
      // Never negative, and measured in hours from a span of seconds.
      expect(inProgress!.averageHours).toBeGreaterThanOrEqual(0);
    });

    it("reports nothing to a workspace it does not belong to", async () => {
      const item = await newItem("Report: tenancy");
      await store.updateFeature(item.specId, { status: "in_progress" }, asOwner);

      const stranger = { userId: randomUUID(), workspaceId: randomUUID() };
      const summary = await store.itemActivitySummary(WIDE, stranger);
      expect(summary.total).toBe(0);
      expect(summary.since).toBeNull();
    });
  });
});
