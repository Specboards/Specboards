import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Workspace roll-up integration suite (the leadership dashboard's data source),
 * against a migrated Postgres with RLS active via a non-owner app role (same
 * provisioning as rls-isolation.int.test.ts).
 *
 * Covers the two things the dashboard cannot get wrong: aggregates that include
 * ungrouped products (the gap a per-group roll-up leaves), and per-product
 * visibility, where a private product must contribute nothing at all, not even
 * to a total. Then the three escalation signals, including their caps.
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

const wsId = randomUUID();
const user = { owner: randomUUID(), member: randomUUID() };
/** open: org-visible. closed: private, and the member is not a product member. */
const productId = { open: randomUUID(), closed: randomUUID() };
const groupId = randomUUID();
const releaseId = { past: randomUUID(), future: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const ownerScope = { userId: user.owner, workspaceId: wsId };
const memberScope = { userId: user.member, workspaceId: wsId };

/** Fixed "today" so the overdue signal is deterministic. */
const TODAY = "2026-07-26";
const options = {
  today: TODAY,
  activeStatuses: ["in_progress", "in_review"],
};

/** A day offset from TODAY as YYYY-MM-DD. */
function daysFromToday(days: number): string {
  const ms = Date.parse(`${TODAY}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

describe.skipIf(!OWNER_URL)("workspace summary (store + RLS)", () => {
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
      (${wsId}, 'Summary WS', ${"sum-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@sum.test`}),
      (${user.member}, 'Member', ${`member-${suffix}@sum.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${wsId}, ${user.owner}, 'owner'),
      (${wsId}, ${user.member}, 'member')`;
    await owner`insert into product_groups (id, workspace_id, key, name, position) values
      (${groupId}, ${wsId}, 'platform', 'Platform', 0)`;
    // `open` sits in a group; `closed` is ungrouped *and* private, so it covers
    // both the ungrouped case and the visibility case.
    await owner`insert into products (id, workspace_id, key, name, group_id, visibility, position) values
      (${productId.open}, ${wsId}, 'open', 'Open', ${groupId}, 'org', 0),
      (${productId.closed}, ${wsId}, 'closed', 'Closed', null, 'private', 1)`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${wsId}, 'work', 'Work Items', 0, true)`;
    await owner`insert into releases (id, workspace_id, product_id, name, status, target_date) values
      (${releaseId.past}, ${wsId}, ${productId.open}, ${"overdue-" + suffix}, 'in_progress', ${daysFromToday(-3)}),
      (${releaseId.future}, ${wsId}, ${productId.open}, ${"upcoming-" + suffix}, 'planned', ${daysFromToday(30)})`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`update products set group_id = null where workspace_id = ${wsId}`;
    await owner`delete from product_groups where workspace_id = ${wsId}`;
    await owner`delete from workspaces where id = ${wsId}`;
    await owner`delete from users where id in (${user.owner}, ${user.member})`;
    await owner.end({ timeout: 5 });
  });

  it("rolls up every readable product, grouped or not", async () => {
    await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id) values
      (${randomUUID()}, ${wsId}, ${productId.open}, 'work', 'open one', 'backlog', null),
      (${randomUUID()}, ${wsId}, ${productId.open}, 'work', 'open two', 'done', ${releaseId.past}),
      (${randomUUID()}, ${wsId}, ${productId.closed}, 'work', 'closed one', 'backlog', null)`;

    const summary = await store.getWorkspaceSummary(options, ownerScope);
    const byProduct = new Map(summary.products.map((p) => [p.productId, p]));

    // The ungrouped private product is present for the owner: a per-group
    // roll-up would have missed it entirely.
    expect([...byProduct.keys()].sort()).toEqual(
      [productId.open, productId.closed].sort(),
    );
    expect(byProduct.get(productId.open)!.itemCount).toBe(2);
    expect(byProduct.get(productId.open)!.statusCounts).toEqual({
      backlog: 1,
      done: 1,
    });
    expect(byProduct.get(productId.open)!.releases).toEqual([
      { releaseId: releaseId.past, total: 1, done: 1 },
    ]);
    expect(byProduct.get(productId.closed)!.itemCount).toBe(1);
  });

  it("omits a product the viewer cannot read, from the list and the totals", async () => {
    const summary = await store.getWorkspaceSummary(options, memberScope);
    expect(summary.products.map((p) => p.productId)).toEqual([productId.open]);
    // Totals are computed over the returned products only, so the private
    // product's single item cannot show up in an org-wide count.
    const total = summary.products.reduce((a, p) => a + p.itemCount, 0);
    expect(total).toBe(2);
  });

  it("flags blocked, overdue, and stale work, and nothing else", async () => {
    const blockedSpec = randomUUID();
    const blockerSpec = randomUUID();
    const staleSpec = randomUUID();
    const freshSpec = randomUUID();
    await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id) values
      (${blockedSpec}, ${wsId}, ${productId.open}, 'work', 'blocked', 'in_progress', ${releaseId.future}),
      (${blockerSpec}, ${wsId}, ${productId.open}, 'work', 'blocker', 'in_progress', ${releaseId.future})`;
    // Stale rows need an old updated_at, which the store sets on write.
    await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id, updated_at) values
      (${staleSpec}, ${wsId}, ${productId.open}, 'work', 'stale', 'in_progress', ${releaseId.future}, ${daysFromToday(-40)}),
      (${freshSpec}, ${wsId}, ${productId.open}, 'work', 'fresh', 'in_progress', ${releaseId.future}, ${daysFromToday(-1)})`;
    const featureId = async (specId: string): Promise<string> => {
      const rows = await owner<{ id: string }[]>`
        select id from features where spec_id = ${specId}`;
      return rows[0]!.id;
    };
    const blockedId = await featureId(blockedSpec);
    const blockerId = await featureId(blockerSpec);
    await owner`insert into feature_links (workspace_id, from_feature_id, to_feature_id, type) values
      (${wsId}, ${blockerId}, ${blockedId}, 'blocks')`;

    const { signals } = await store.getWorkspaceSummary(options, ownerScope);

    // Blocked is the to_feature_id side of the edge; the blocker itself is not.
    expect(signals.blocked.map((i) => i.title)).toEqual(["blocked"]);
    expect(signals.counts.blocked).toBe(1);

    // "open two" is scheduled into the overdue release but is done, so only the
    // live items on a past-target release count. That release holds no live
    // items, and the items above sit on the future release, so nothing is
    // overdue.
    expect(signals.overdue).toEqual([]);
    expect(signals.counts.overdue).toBe(0);

    expect(signals.stale.map((i) => i.title)).toEqual(["stale"]);
    expect(signals.stale[0]!.staleDays).toBeGreaterThanOrEqual(39);
    expect(signals.counts.stale).toBe(1);
  });

  it("counts an item on a past-target release as overdue until it is done", async () => {
    const spec = randomUUID();
    await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id) values
      (${spec}, ${wsId}, ${productId.open}, 'work', 'late', 'in_progress', ${releaseId.past})`;

    const before = await store.getWorkspaceSummary(options, ownerScope);
    expect(before.signals.overdue.map((i) => i.title)).toEqual(["late"]);

    await owner`update features set status = 'done' where spec_id = ${spec}`;
    const after = await store.getWorkspaceSummary(options, ownerScope);
    expect(after.signals.overdue).toEqual([]);
  });

  it("respects visibility in the signals, not just the aggregates", async () => {
    const spec = randomUUID();
    await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id, updated_at) values
      (${spec}, ${wsId}, ${productId.closed}, 'work', 'secret stale', 'in_progress', null, ${daysFromToday(-40)})`;

    const asOwner = await store.getWorkspaceSummary(options, ownerScope);
    expect(asOwner.signals.stale.map((i) => i.title)).toContain("secret stale");

    // The member cannot read that product, so its title must not surface in a
    // signal either.
    const asMember = await store.getWorkspaceSummary(options, memberScope);
    expect(asMember.signals.stale.map((i) => i.title)).not.toContain(
      "secret stale",
    );
  });

  it("caps each signal's sample while keeping the true count", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    for (const i of rows) {
      await owner`insert into features (spec_id, workspace_id, product_id, level, title, status, release_id, updated_at) values
        (${randomUUID()}, ${wsId}, ${productId.open}, 'work', ${`bulk stale ${i}`}, 'in_progress', null, ${daysFromToday(-30)})`;
    }
    const { signals } = await store.getWorkspaceSummary(options, ownerScope);
    expect(signals.stale).toHaveLength(8);
    expect(signals.counts.stale).toBeGreaterThanOrEqual(13);
  });

  it("reports no stale work when the caller names no active statuses", async () => {
    const { signals } = await store.getWorkspaceSummary(
      { today: TODAY, activeStatuses: [] },
      ownerScope,
    );
    expect(signals.stale).toEqual([]);
    expect(signals.counts.stale).toBe(0);
  });

  it("refuses a malformed today rather than reporting a bogus count", async () => {
    await expect(
      store.getWorkspaceSummary(
        { today: "26-07-2026", activeStatuses: [] },
        ownerScope,
      ),
    ).rejects.toThrow(/invalid today/);
  });
});
