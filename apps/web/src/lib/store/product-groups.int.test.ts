import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { GroupError } from "./types";

/**
 * Product-groups integration suite: exercises the group store methods against
 * a migrated Postgres with the RLS policies from migration 0039 active, via a
 * non-owner app role (same provisioning as rls-isolation.int.test.ts).
 *
 * Covers: workspace scoping of group reads, create + product assignment,
 * cross-workspace groupId rejection, RLS denial of non-admin writes, cycle
 * and populated-delete guards.
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

const ws = { a: randomUUID(), b: randomUUID() };
const user = { alice: randomUUID(), bob: randomUUID(), carol: randomUUID() };
const productId = { alpha: randomUUID(), beta: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const scopeA = { userId: user.alice, workspaceId: ws.a };
const scopeB = { userId: user.bob, workspaceId: ws.b };
const scopeCarol = { userId: user.carol, workspaceId: ws.a };

describe.skipIf(!OWNER_URL)("product groups (store + RLS)", () => {
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
      (${ws.a}, 'Groups A', ${"grp-int-a-" + suffix}),
      (${ws.b}, 'Groups B', ${"grp-int-b-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${suffix}@grp.test`}),
      (${user.bob}, 'Bob', ${`bob-${suffix}@grp.test`}),
      (${user.carol}, 'Carol', ${`carol-${suffix}@grp.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws.a}, ${user.alice}, 'owner'),
      (${ws.b}, ${user.bob}, 'owner'),
      (${ws.a}, ${user.carol}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId.alpha}, ${ws.a}, 'alpha', 'Alpha'),
      (${productId.beta}, ${ws.b}, 'beta', 'Beta')`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    // Groups block workspace cascade via products' composite FK ordering only
    // when populated; clear product membership first, then cascade the rest.
    await owner`update products set group_id = null where workspace_id in (${ws.a}, ${ws.b})`;
    await owner`delete from product_groups where workspace_id in (${ws.a}, ${ws.b})`;
    await owner`delete from workspaces where id in (${ws.a}, ${ws.b})`;
    await owner`delete from users where id in (${user.alice}, ${user.bob}, ${user.carol})`;
    await owner.end({ timeout: 5 });
  });

  it("creates a group and lists it only in its own workspace", async () => {
    const group = await store.createProductGroup({ name: "Payments Platform" }, scopeA);
    expect(group.key).toBe("payments-platform");

    const inA = await store.listProductGroups(scopeA);
    expect(inA.map((g) => g.id)).toContain(group.id);

    const inB = await store.listProductGroups(scopeB);
    expect(inB.map((g) => g.id)).not.toContain(group.id);
  });

  it("assigns a product to a group via updateProduct and counts it", async () => {
    const [group] = await store.listProductGroups(scopeA);
    const updated = await store.updateProduct(
      productId.alpha,
      { groupId: group!.id },
      scopeA,
    );
    expect(updated.groupId).toBe(group!.id);

    const groups = await store.listProductGroups(scopeA);
    expect(groups.find((g) => g.id === group!.id)?.productCount).toBe(1);
  });

  it("rejects assigning a product to another workspace's group", async () => {
    const [groupInA] = await store.listProductGroups(scopeA);
    await expect(
      store.updateProduct(productId.beta, { groupId: groupInA!.id }, scopeB),
    ).rejects.toThrow(GroupError);
  });

  it("denies group creation to a non-admin member via RLS", async () => {
    await expect(
      store.createProductGroup({ name: "Carols Group" }, scopeCarol),
    ).rejects.toThrow();
  });

  it("still lets a non-admin member read groups", async () => {
    const groups = await store.listProductGroups(scopeCarol);
    expect(groups.length).toBeGreaterThan(0);
  });

  it("rejects nesting a group inside its own subtree", async () => {
    const parent = await store.createProductGroup({ name: "Cycle Parent" }, scopeA);
    const child = await store.createProductGroup(
      { name: "Cycle Child", parentId: parent.id },
      scopeA,
    );
    await expect(
      store.updateProductGroup(parent.id, { parentId: child.id }, scopeA),
    ).rejects.toThrow(GroupError);
  });

  it("blocks deleting a group that still has products or subgroups", async () => {
    const groups = await store.listProductGroups(scopeA);
    const populated = groups.find((g) => g.productCount > 0)!;
    await expect(store.deleteProductGroup(populated.id, scopeA)).rejects.toThrow(
      GroupError,
    );

    const withChild = groups.find((g) => g.name === "Cycle Parent")!;
    await expect(store.deleteProductGroup(withChild.id, scopeA)).rejects.toThrow(
      GroupError,
    );
  });

  it("deletes an empty group and unassigns products cleanly", async () => {
    await store.updateProduct(productId.alpha, { groupId: null }, scopeA);
    const groups = await store.listProductGroups(scopeA);
    // Delete leaf-first: Cycle Child, then Cycle Parent, then the empty first group.
    const child = groups.find((g) => g.name === "Cycle Child")!;
    await store.deleteProductGroup(child.id, scopeA);
    const parent = groups.find((g) => g.name === "Cycle Parent")!;
    await store.deleteProductGroup(parent.id, scopeA);
    const first = groups.find((g) => g.name === "Payments Platform")!;
    await store.deleteProductGroup(first.id, scopeA);
    expect(await store.listProductGroups(scopeA)).toEqual([]);
  });
});
