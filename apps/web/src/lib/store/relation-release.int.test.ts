import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * The db store's half of the release-on-a-relation contract.
 *
 * `FeatureRelation` carries the other end's release so a relations list can
 * answer "does this blocker ship before me?" without a click. Both stores build
 * that shape, and the local half is pinned in local-relation-release.test.ts.
 * This is the same contract against a real Postgres, because the two are only
 * honest if both are checked: a field one store fills and the other leaves null
 * is a bug that shows up in one deployment shape and is invisible in the other.
 *
 * The case worth having a database for is the last one. Relations may point at
 * items in products the caller cannot read, those edges are dropped, and the
 * release lookup is driven off the surviving set. That interaction has no
 * equivalent in local file mode, which has no product access rules.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const user = { owner: randomUUID(), viewer: randomUUID() };
const product = { alpha: randomUUID(), secret: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

describe.skipIf(!OWNER_URL)("a relation carries the other end's release", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'RelRelease', ${"relrel-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@relrel.test`}),
      (${user.viewer}, 'Viewer', ${`viewer-${suffix}@relrel.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.viewer}, 'member')`;
    // Secret is `private`, so reading it needs a per-product grant. An `org`
    // product (the default) is readable by every member, which is why the
    // unreadable case below has to opt out of that default rather than rely on
    // the absence of a grant.
    await owner`insert into products (id, workspace_id, key, name, visibility) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha', 'org'),
      (${product.secret}, ${ws}, 'secret', 'Secret', 'private')`;
    // The viewer can read Alpha and has no grant at all on Secret.
    await owner`insert into product_members (workspace_id, product_id, user_id, role) values
      (${ws}, ${product.alpha}, ${user.viewer}, 'viewer')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(OWNER_URL!);
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.viewer})`;
    await owner.end({ timeout: 5 });
  });

  /** Two epics in `productId` and a blocked_by edge from subject to blocker. */
  async function twoLinkedItems(releaseId: string | null, productId: string) {
    const subject = await store.createFeature(
      { title: `Subject ${randomUUID().slice(0, 6)}`, level: "epic", productId },
      asOwner,
    );
    const blocker = await store.createFeature(
      {
        title: `Blocker ${randomUUID().slice(0, 6)}`,
        level: "epic",
        productId,
        releaseId,
      },
      asOwner,
    );
    await store.addRelation(
      subject.specId,
      { toSpecId: blocker.specId, direction: "blocked_by" },
      asOwner,
    );
    return { subject, blocker };
  }

  it("names the release the other end is scheduled into", async () => {
    const rel = await store.createRelease(
      { name: `v-named-${suffix}`, productId: product.alpha },
      asOwner,
    );
    const { subject, blocker } = await twoLinkedItems(rel.id, product.alpha);

    const detail = (await store.getFeature(subject.specId, asOwner))!;
    const edge = detail.relations.find((r) => r.otherSpecId === blocker.specId)!;
    expect(edge.otherReleaseId).toBe(rel.id);
    expect(edge.otherReleaseName).toBe(`v-named-${suffix}`);
  });

  it("leaves both halves null for an unscheduled relation", async () => {
    // The common case, and the reason the renderer draws nothing rather than
    // "None": a populated id here would put a chip on most rows in the app.
    const { subject, blocker } = await twoLinkedItems(null, product.alpha);

    const detail = (await store.getFeature(subject.specId, asOwner))!;
    const edge = detail.relations.find((r) => r.otherSpecId === blocker.specId)!;
    expect(edge.otherReleaseId).toBeNull();
    expect(edge.otherReleaseName).toBeNull();
  });

  it("reports the release from whichever end is being read", async () => {
    // One stored edge, rendered from both sides, so "the other end" depends on
    // who is asking. Getting this backwards would show an item its own release
    // on every relation, which reads as correct.
    const rel = await store.createRelease(
      { name: `v-ends-${suffix}`, productId: product.alpha },
      asOwner,
    );
    const { subject, blocker } = await twoLinkedItems(rel.id, product.alpha);

    const fromBlocker = (await store.getFeature(blocker.specId, asOwner))!;
    const edge = fromBlocker.relations.find(
      (r) => r.otherSpecId === subject.specId,
    )!;
    expect(edge.direction).toBe("blocks");
    expect(edge.otherReleaseName).toBeNull();

    const fromSubject = (await store.getFeature(subject.specId, asOwner))!;
    expect(
      fromSubject.relations.find((r) => r.otherSpecId === blocker.specId)!
        .otherReleaseName,
    ).toBe(`v-ends-${suffix}`);
  });

  it("drops the whole edge, release and all, when the other end is unreadable", async () => {
    // The interaction that needs a database. The blocker lives in a product the
    // viewer has no grant on, so the edge is filtered before the release lookup
    // ever sees it, and the owner reading the same item still gets the badge.
    const rel = await store.createRelease(
      { name: `v-secret-${suffix}`, productId: product.secret },
      asOwner,
    );
    const subject = await store.createFeature(
      { title: `Visible ${suffix}`, level: "epic", productId: product.alpha },
      asOwner,
    );
    const blocker = await store.createFeature(
      {
        title: `Hidden ${suffix}`,
        level: "epic",
        productId: product.secret,
        releaseId: rel.id,
      },
      asOwner,
    );
    await store.addRelation(
      subject.specId,
      { toSpecId: blocker.specId, direction: "blocked_by" },
      asOwner,
    );

    const asSeenByViewer = (await store.getFeature(subject.specId, asViewer))!;
    expect(
      asSeenByViewer.relations.some((r) => r.otherSpecId === blocker.specId),
    ).toBe(false);

    const asSeenByOwner = (await store.getFeature(subject.specId, asOwner))!;
    expect(
      asSeenByOwner.relations.find((r) => r.otherSpecId === blocker.specId)!
        .otherReleaseName,
    ).toBe(`v-secret-${suffix}`);
  });
});
