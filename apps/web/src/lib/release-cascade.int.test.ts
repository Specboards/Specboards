import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Carrying a release change down to the work underneath it, for real.
 *
 * `release-cascade.test.ts` pins the decision without a database. This pins the
 * write, because the failure mode of a bulk convenience is that it looks
 * identical whether it moved seventeen items or none: the call returns, the
 * parent is in the release, and nobody notices the children are not until the
 * release reports the wrong contents. That is the original bug, so a test that
 * only proved the planner would be testing the half that was never in doubt.
 *
 * Runs against DATABASE_URL; skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const suffix = randomUUID().slice(0, 8);
const ws = randomUUID();
const user = { owner: randomUUID() };
const product = { alpha: randomUUID(), beta: randomUUID() };

const asOwner = { userId: user.owner, workspaceId: ws };

describe.skipIf(!DB_URL)("cascading a release to the work beneath it", () => {
  let sql: postgres.Sql;
  let features: typeof import("./features-service");
  let cascade: typeof import("./release-cascade-service");
  let store: typeof import("./store");

  /** v-target in Alpha, plus a decoy release to park deliberate choices in. */
  let target: string;
  let other: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    delete process.env.SPECBOARDS_MULTI_TENANT;

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Cascade', ${"cascade-int-" + suffix})`;
    await sql`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@cascade.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha'),
      (${product.beta}, ${ws}, 'beta', 'Beta')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'initiative', 'Initiatives', 0, false),
      (${ws}, 'epic', 'Epics', 1, false),
      (${ws}, 'story', 'Stories', 2, true)`;

    features = await import("./features-service");
    cascade = await import("./release-cascade-service");
    store = await import("./store");

    const s = await store.getStore();
    target = (
      await s.createRelease(
        { name: `v-target-${suffix}`, productId: product.alpha },
        asOwner,
      )
    ).id;
    other = (
      await s.createRelease(
        { name: `v-other-${suffix}`, productId: product.alpha },
        asOwner,
      )
    ).id;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id = ${user.owner}`;
    await sql.end({ timeout: 5 });
  });

  /**
   * initiative -> epic -> story, all in Alpha and all unscheduled.
   * Fresh per test so one test's writes cannot decide another's outcome.
   */
  async function tree(productId = product.alpha) {
    const s = await store.getStore();
    const root = await s.createFeature(
      { title: `Root ${randomUUID().slice(0, 6)}`, level: "initiative", productId },
      asOwner,
    );
    const epic = await s.createFeature(
      {
        title: `Epic ${randomUUID().slice(0, 6)}`,
        level: "epic",
        productId,
        parentSpecId: root.specId,
      },
      asOwner,
    );
    const story = await s.createFeature(
      {
        title: `Story ${randomUUID().slice(0, 6)}`,
        level: "story",
        productId,
        parentSpecId: epic.specId,
      },
      asOwner,
    );
    return { root, epic, story };
  }

  /** The release an item is actually sitting in, read back from the database. */
  async function releaseOf(specId: string): Promise<string | null> {
    const s = await store.getStore();
    return (await s.getFeature(specId, asOwner))!.releaseId;
  }

  it("moves one row and nothing else without the flag", async () => {
    // Today's behaviour, kept exactly. Every existing caller relies on it.
    const { root, epic, story } = await tree();
    await features.patchFeature(root.specId, { releaseId: target }, asOwner);

    expect(await releaseOf(root.specId)).toBe(target);
    expect(await releaseOf(epic.specId)).toBeNull();
    expect(await releaseOf(story.specId)).toBeNull();
  });

  it("carries the release down the whole subtree with the flag", async () => {
    const { root, epic, story } = await tree();
    await features.patchFeature(root.specId, { releaseId: target }, asOwner, {
      cascadeRelease: true,
    });

    expect(await releaseOf(root.specId)).toBe(target);
    expect(await releaseOf(epic.specId)).toBe(target);
    // The grandchild is the point: stopping at direct children would recreate
    // the same bug one level down.
    expect(await releaseOf(story.specId)).toBe(target);
  });

  it("leaves a descendant that someone deliberately scheduled elsewhere", async () => {
    const { root, epic, story } = await tree();
    const s = await store.getStore();
    await s.updateFeature(epic.specId, { releaseId: other }, asOwner);

    await features.patchFeature(root.specId, { releaseId: target }, asOwner, {
      cascadeRelease: true,
    });

    expect(await releaseOf(epic.specId)).toBe(other);
    // ...and still reaches past it, because being in another release does not
    // seal off the unscheduled work underneath.
    expect(await releaseOf(story.specId)).toBe(target);
  });

  it("never unschedules a subtree when the parent's release is cleared", async () => {
    // The dangerous direction. An earlier draft of the planner cascaded a clear
    // and would have wiped every schedule beneath the item.
    const { root, epic, story } = await tree();
    await features.patchFeature(root.specId, { releaseId: target }, asOwner, {
      cascadeRelease: true,
    });
    await features.patchFeature(root.specId, { releaseId: null }, asOwner, {
      cascadeRelease: true,
    });

    expect(await releaseOf(root.specId)).toBeNull();
    expect(await releaseOf(epic.specId)).toBe(target);
    expect(await releaseOf(story.specId)).toBe(target);
  });

  it("reports what it would do without doing any of it", async () => {
    const { root, epic, story } = await tree();
    const { plan, releaseName } = await cascade.planItemReleaseCascade(
      root.specId,
      target,
      asOwner,
    );

    expect(releaseName).toBe(`v-target-${suffix}`);
    expect(plan.move.sort()).toEqual([epic.specId, story.specId].sort());
    expect(plan.depth).toBe(2);
    // A plan is a read. Nothing moved.
    expect(await releaseOf(epic.specId)).toBeNull();
  });

  it("plans nothing for a leaf, so the prompt never appears for one", async () => {
    const { story } = await tree();
    const { plan } = await cascade.planItemReleaseCascade(
      story.specId,
      target,
      asOwner,
    );
    expect(plan.move).toEqual([]);
    expect(plan.depth).toBe(0);
  });

  it("will not push a product's release onto an item from another product", async () => {
    // The store would refuse the write, so a planner that included it would
    // half-apply the cascade and throw partway. It is excluded up front.
    const s = await store.getStore();
    const root = await s.createFeature(
      { title: `Mixed ${suffix}`, level: "initiative", productId: product.alpha },
      asOwner,
    );
    const foreign = await s.createFeature(
      {
        title: `Foreign ${suffix}`,
        level: "epic",
        productId: product.beta,
        parentSpecId: root.specId,
      },
      asOwner,
    );

    const { plan } = await cascade.planItemReleaseCascade(
      root.specId,
      target,
      asOwner,
    );
    expect(plan.ineligible).toEqual([foreign.specId]);
    expect(plan.move).toEqual([]);

    await features.patchFeature(root.specId, { releaseId: target }, asOwner, {
      cascadeRelease: true,
    });
    expect(await releaseOf(foreign.specId)).toBeNull();
  });
});
