import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { ReleaseError, RelationError } from "./types";

/**
 * Per-product releases integration suite: exercises the release store methods
 * against a migrated Postgres with RLS active, via a non-owner app role (same
 * provisioning as product-groups.int.test.ts).
 *
 * Covers: product admin/contributor can manage their product's releases, a
 * viewer cannot; portfolio (null-product) releases are owner-only; release
 * names are unique per product (two products can share a name); an item can
 * only be scheduled into a release from its own product or a portfolio release.
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
  admin: randomUUID(),
  contributor: randomUUID(),
  viewer: randomUUID(),
};
const product = { alpha: randomUUID(), beta: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asAdmin = { userId: user.admin, workspaceId: ws };
const asContributor = { userId: user.contributor, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

describe.skipIf(!OWNER_URL)("per-product releases (store + RLS)", () => {
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
      (${ws}, 'Releases', ${"rel-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@rel.test`}),
      (${user.admin}, 'Admin', ${`admin-${suffix}@rel.test`}),
      (${user.contributor}, 'Contributor', ${`contrib-${suffix}@rel.test`}),
      (${user.viewer}, 'Viewer', ${`viewer-${suffix}@rel.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.admin}, 'member'),
      (${ws}, ${user.contributor}, 'member'),
      (${ws}, ${user.viewer}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha'),
      (${product.beta}, ${ws}, 'beta', 'Beta')`;
    // Per-product roles on Alpha; nobody has a grant on Beta.
    await owner`insert into product_members (workspace_id, product_id, user_id, role) values
      (${ws}, ${product.alpha}, ${user.admin}, 'admin'),
      (${ws}, ${product.alpha}, ${user.contributor}, 'contributor'),
      (${ws}, ${product.alpha}, ${user.viewer}, 'viewer')`;
    // A non-leaf top level (so DB-native items can be created there) plus a
    // leaf child (leaf items come from specs, not createFeature).
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.admin}, ${user.contributor}, ${user.viewer})`;
    await owner.end({ timeout: 5 });
  });

  it("lets a product admin create + update a release for their product", async () => {
    const rel = await store.createRelease(
      { name: "v1.0", productId: product.alpha, targetDate: "2026-08-01" },
      asAdmin,
    );
    expect(rel.productId).toBe(product.alpha);
    expect(rel.targetDate).toBe("2026-08-01");

    const updated = await store.updateRelease(
      rel.id,
      { targetDate: "2026-09-01" },
      asAdmin,
    );
    expect(updated.targetDate).toBe("2026-09-01");
  });

  it("lets a product contributor create a release for their product", async () => {
    const rel = await store.createRelease(
      { name: "v1.1", productId: product.alpha },
      asContributor,
    );
    expect(rel.productId).toBe(product.alpha);
  });

  it("rejects a viewer creating or editing a product's release", async () => {
    await expect(
      store.createRelease({ name: "nope", productId: product.alpha }, asViewer),
    ).rejects.toThrow(ReleaseError);

    const [existing] = (await store.listReleases(asViewer)).filter(
      (r) => r.productId === product.alpha,
    );
    await expect(
      store.updateRelease(existing!.id, { targetDate: "2027-01-01" }, asViewer),
    ).rejects.toThrow(ReleaseError);
  });

  it("makes portfolio (null-product) releases owner-only", async () => {
    await expect(
      store.createRelease({ name: "portfolio-x", productId: null }, asAdmin),
    ).rejects.toThrow(ReleaseError);

    const rel = await store.createRelease(
      { name: "2026-H2", productId: null },
      asOwner,
    );
    expect(rel.productId).toBeNull();
  });

  it("scopes release names per product (two products can share a name)", async () => {
    // Alpha already has v1.0 (admin). Beta gets its own v1.0 (owner, no beta grant).
    const beta = await store.createRelease(
      { name: "v1.0", productId: product.beta },
      asOwner,
    );
    expect(beta.productId).toBe(product.beta);

    // A second v1.0 in the same product collides.
    await expect(
      store.createRelease({ name: "v1.0", productId: product.alpha }, asOwner),
    ).rejects.toThrow(ReleaseError);
  });

  it("only schedules an item into a release from its product or portfolio", async () => {
    const item = await store.createFeature(
      { title: "Alpha epic", level: "epic", productId: product.alpha },
      asOwner,
    );
    const releases = await store.listReleases(asOwner);
    const alphaRel = releases.find((r) => r.productId === product.alpha)!;
    const betaRel = releases.find((r) => r.productId === product.beta)!;
    const portfolioRel = releases.find((r) => r.productId === null)!;

    // Another product's release is rejected.
    await expect(
      store.updateFeature(item.specId, { releaseId: betaRel.id }, asOwner),
    ).rejects.toThrow(RelationError);

    // Its own product's release, and a portfolio release, are allowed.
    await store.updateFeature(item.specId, { releaseId: alphaRel.id }, asOwner);
    await store.updateFeature(item.specId, { releaseId: portfolioRel.id }, asOwner);
  });
});
