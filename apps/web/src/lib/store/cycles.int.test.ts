import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { CycleError } from "./types";

/**
 * Cycles integration suite: exercises the cycle store methods against a
 * migrated Postgres with RLS active, via a non-owner app role (same
 * provisioning as releases.int.test.ts).
 *
 * Covers the card's acceptance criteria: an item holds a release AND a cycle
 * simultaneously and clearing one does not touch the other; cycle visibility
 * and writes follow the same product-scoped rules as releases; deleting a cycle
 * unschedules its items and deletes no work; and cycle state changes as dates
 * pass with no user action and no cron. Plus rollover, which moves unfinished
 * work only.
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
  contributor: randomUUID(),
  viewer: randomUUID(),
};
const product = { alpha: randomUUID(), beta: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asContributor = { userId: user.contributor, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

/** Dates well in the past / future so the suite never depends on "today". */
const PAST = { startDate: "2020-01-01", endDate: "2020-01-14" };
const FUTURE = { startDate: "2099-01-01", endDate: "2099-01-14" };

describe.skipIf(!OWNER_URL)("cycles (store + RLS)", () => {
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
      (${ws}, 'Cycles', ${"cyc-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@cyc.test`}),
      (${user.contributor}, 'Contributor', ${`contrib-${suffix}@cyc.test`}),
      (${user.viewer}, 'Viewer', ${`viewer-${suffix}@cyc.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.contributor}, 'member'),
      (${ws}, ${user.viewer}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha'),
      (${product.beta}, ${ws}, 'beta', 'Beta')`;
    await owner`insert into product_members (workspace_id, product_id, user_id, role) values
      (${ws}, ${product.alpha}, ${user.contributor}, 'contributor'),
      (${ws}, ${product.alpha}, ${user.viewer}, 'viewer')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${user.owner}, ${user.contributor}, ${user.viewer})`;
    await owner.end({ timeout: 5 });
  });

  it("derives state from the dates, with nothing having to run", async () => {
    const past = await store.createCycle(
      { name: "Sprint past", productId: product.alpha, ...PAST },
      asOwner,
    );
    const future = await store.createCycle(
      { name: "Sprint future", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    // Straight off the create, and again off a fresh read: no stored column, no
    // cron, no write-on-read.
    expect(past.state).toBe("complete");
    expect(future.state).toBe("upcoming");

    const listed = await store.listCycles(asOwner);
    expect(listed.find((c) => c.id === past.id)!.state).toBe("complete");
    expect(listed.find((c) => c.id === future.id)!.state).toBe("upcoming");
  });

  it("rejects a cycle that ends before it starts", async () => {
    await expect(
      store.createCycle(
        {
          name: "Backwards",
          productId: product.alpha,
          startDate: "2026-08-10",
          endDate: "2026-08-01",
        },
        asOwner,
      ),
    ).rejects.toThrow(/cannot end before it starts/);
  });

  it("keeps names unique per product, but lets two products share one", async () => {
    await store.createCycle(
      { name: "Sprint 1", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    await expect(
      store.createCycle(
        { name: "Sprint 1", productId: product.alpha, ...FUTURE },
        asOwner,
      ),
    ).rejects.toThrow(/already exists/);
    // Same name under a different product is fine.
    const beta = await store.createCycle(
      { name: "Sprint 1", productId: product.beta, ...FUTURE },
      asOwner,
    );
    expect(beta.productId).toBe(product.beta);
  });

  it("lets a product contributor manage that product's cycles, but not a viewer", async () => {
    const mine = await store.createCycle(
      { name: "Contributor sprint", productId: product.alpha, ...FUTURE },
      asContributor,
    );
    expect(mine.productId).toBe(product.alpha);

    await expect(
      store.createCycle(
        { name: "Viewer sprint", productId: product.alpha, ...FUTURE },
        asViewer,
      ),
    ).rejects.toThrow(CycleError);
    await expect(
      store.updateCycle(mine.id, { name: "Renamed" }, asViewer),
    ).rejects.toThrow(CycleError);
    // Beta is a product the contributor has no grant on at all.
    await expect(
      store.createCycle(
        { name: "Not mine", productId: product.beta, ...FUTURE },
        asContributor,
      ),
    ).rejects.toThrow(CycleError);
  });

  it("makes workspace-wide cycles owner-only", async () => {
    const global = await store.createCycle(
      { name: "Company sprint", productId: null, ...FUTURE },
      asOwner,
    );
    expect(global.productId).toBeNull();
    await expect(
      store.createCycle(
        { name: "Nope", productId: null, ...FUTURE },
        asContributor,
      ),
    ).rejects.toThrow(/Only the workspace owner/);
  });

  it("holds a release and a cycle at once, each clearable alone", async () => {
    const release = await store.createRelease(
      { name: "v9.9", productId: product.alpha },
      asOwner,
    );
    const cycle = await store.createCycle(
      { name: "Sprint both", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    const item = await store.createFeature(
      {
        title: "Dual-scheduled",
        level: "epic",
        productId: product.alpha,
        releaseId: release.id,
        cycleId: cycle.id,
      },
      asOwner,
    );
    expect(item.releaseId).toBe(release.id);
    expect(item.cycleId).toBe(cycle.id);

    // Clearing the cycle leaves the release alone...
    await store.updateFeature(item.specId, { cycleId: null }, asOwner);
    let read = await store.getFeature(item.specId, asOwner);
    expect(read!.cycleId).toBeNull();
    expect(read!.releaseId).toBe(release.id);

    // ...and vice versa.
    await store.updateFeature(
      item.specId,
      { cycleId: cycle.id, releaseId: null },
      asOwner,
    );
    read = await store.getFeature(item.specId, asOwner);
    expect(read!.cycleId).toBe(cycle.id);
    expect(read!.releaseId).toBeNull();
  });

  it("refuses to schedule an item into another product's cycle", async () => {
    const betaCycle = await store.createCycle(
      { name: "Beta only", productId: product.beta, ...FUTURE },
      asOwner,
    );
    const item = await store.createFeature(
      { title: "Alpha work", level: "epic", productId: product.alpha },
      asOwner,
    );
    await expect(
      store.updateFeature(item.specId, { cycleId: betaCycle.id }, asOwner),
    ).rejects.toThrow(/different product/);
  });

  it("unschedules items when a cycle is deleted, deleting no work", async () => {
    const cycle = await store.createCycle(
      { name: "Doomed", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    const item = await store.createFeature(
      {
        title: "Survivor",
        level: "epic",
        productId: product.alpha,
        cycleId: cycle.id,
      },
      asOwner,
    );
    await store.deleteCycle(cycle.id, asOwner);

    const read = await store.getFeature(item.specId, asOwner);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Survivor");
    expect(read!.cycleId).toBeNull();
  });

  it("counts items and done items on a cycle", async () => {
    const cycle = await store.createCycle(
      { name: "Counted", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    const a = await store.createFeature(
      {
        title: "A",
        level: "epic",
        productId: product.alpha,
        cycleId: cycle.id,
      },
      asOwner,
    );
    await store.createFeature(
      {
        title: "B",
        level: "epic",
        productId: product.alpha,
        cycleId: cycle.id,
      },
      asOwner,
    );
    await store.updateFeature(a.specId, { status: "done" }, asOwner);

    const listed = (await store.listCycles(asOwner)).find(
      (c) => c.id === cycle.id,
    );
    expect(listed!.itemCount).toBe(2);
    expect(listed!.doneCount).toBe(1);
  });

  it("rolls unfinished work forward and leaves finished work behind", async () => {
    const from = await store.createCycle(
      { name: "Closing", productId: product.alpha, ...PAST },
      asOwner,
    );
    const to = await store.createCycle(
      { name: "Opening", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    const unfinished = await store.createFeature(
      {
        title: "Carry",
        level: "epic",
        productId: product.alpha,
        cycleId: from.id,
      },
      asOwner,
    );
    const finished = await store.createFeature(
      {
        title: "Shipped",
        level: "epic",
        productId: product.alpha,
        cycleId: from.id,
      },
      asOwner,
    );
    await store.updateFeature(finished.specId, { status: "done" }, asOwner);

    const result = await store.rolloverCycle(from.id, to.id, asOwner);
    expect(result.moved).toBe(1);
    expect(result.toCycleId).toBe(to.id);

    // The unfinished item moved; the delivered one stayed, so the closed cycle
    // keeps an honest record of what it actually delivered.
    expect((await store.getFeature(unfinished.specId, asOwner))!.cycleId).toBe(
      to.id,
    );
    expect((await store.getFeature(finished.specId, asOwner))!.cycleId).toBe(
      from.id,
    );
  });

  it("refuses a rollover into the same cycle", async () => {
    const cycle = await store.createCycle(
      { name: "Self", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    await expect(
      store.rolloverCycle(cycle.id, cycle.id, asOwner),
    ).rejects.toThrow(/different cycle/);
  });

  it("validates dates as they will be after a partial patch", async () => {
    const cycle = await store.createCycle(
      { name: "Movable", productId: product.alpha, ...FUTURE },
      asOwner,
    );
    // Moving only the start, past the stored end, must still be rejected.
    await expect(
      store.updateCycle(cycle.id, { startDate: "2099-02-01" }, asOwner),
    ).rejects.toThrow(/cannot end before it starts/);

    const ok = await store.updateCycle(
      cycle.id,
      { startDate: "2099-01-05", endDate: "2099-01-20" },
      asOwner,
    );
    expect(ok.startDate).toBe("2099-01-05");
    expect(ok.endDate).toBe("2099-01-20");
  });

  // ── Schedule generation ────────────────────────────────────────────────

  it("generates a contiguous, correctly numbered run in one call", async () => {
    const created = await store.generateCycles(
      {
        productId: product.alpha,
        startDate: "2098-01-05",
        endDate: "2098-03-01",
        lengthDays: 14,
        nameTemplate: `Gen ${suffix} {n}`,
        startNumber: 1,
      },
      asOwner,
    );
    // 2098-01-05 to 2098-03-01 is 56 days: exactly four fortnights.
    expect(created).toHaveLength(4);
    expect(created.map((c) => c.name)).toEqual([
      `Gen ${suffix} 1`,
      `Gen ${suffix} 2`,
      `Gen ${suffix} 3`,
      `Gen ${suffix} 4`,
    ]);
    expect(created[0]!.startDate).toBe("2098-01-05");
    expect(created[3]!.endDate).toBe("2098-03-01");
    for (let i = 1; i < created.length; i++) {
      const prevEnd = Date.parse(`${created[i - 1]!.endDate}T00:00:00Z`);
      const start = Date.parse(`${created[i]!.startDate}T00:00:00Z`);
      expect(start - prevEnd).toBe(86_400_000);
    }
    // They are really persisted, not just returned.
    const listed = await store.listCycles(asOwner);
    for (const c of created) {
      expect(listed.some((l) => l.id === c.id)).toBe(true);
    }
  });

  it("rolls the whole run back when any generated name collides", async () => {
    // Occupy the name the third cycle of the run would take.
    await store.createCycle(
      {
        name: `Clash ${suffix} 3`,
        productId: product.alpha,
        startDate: "2097-06-01",
        endDate: "2097-06-14",
      },
      asOwner,
    );
    const before = (await store.listCycles(asOwner)).length;
    await expect(
      store.generateCycles(
        {
          productId: product.alpha,
          startDate: "2097-01-05",
          endDate: "2097-03-01",
          lengthDays: 14,
          nameTemplate: `Clash ${suffix} {n}`,
          startNumber: 1,
        },
        asOwner,
      ),
    ).rejects.toThrow(/already exists/);
    // The two that would have preceded the clash must not have landed: a
    // half-built schedule is worse than none, since re-running would collide
    // with whatever did persist.
    expect((await store.listCycles(asOwner)).length).toBe(before);
  });

  it("refuses to generate for a product the caller cannot write", async () => {
    await expect(
      store.generateCycles(
        {
          productId: product.beta,
          startDate: "2096-01-05",
          endDate: "2096-03-01",
          lengthDays: 14,
          nameTemplate: `Denied ${suffix} {n}`,
          startNumber: 1,
        },
        asContributor,
      ),
    ).rejects.toThrow(/does not permit/);
  });

  it("refuses a workspace-wide run from a non-owner", async () => {
    await expect(
      store.generateCycles(
        {
          productId: null,
          startDate: "2096-01-05",
          endDate: "2096-03-01",
          lengthDays: 14,
          nameTemplate: `Global ${suffix} {n}`,
          startNumber: 1,
        },
        asContributor,
      ),
    ).rejects.toThrow(/workspace owner/);
  });

  it("applies the core schedule validation", async () => {
    await expect(
      store.generateCycles(
        {
          productId: product.alpha,
          startDate: "2095-01-05",
          endDate: "2095-01-10",
          lengthDays: 14,
          nameTemplate: `Short ${suffix} {n}`,
          startNumber: 1,
        },
        asOwner,
      ),
    ).rejects.toThrow(/end after the end date/);
  });
});
