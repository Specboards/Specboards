import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeTenantConnection, tenantIsolationViolations } from "@specboard/db";

import { DbStore } from "./db";

/**
 * Two-tenant RLS isolation suite: proves that tenant isolation FAILS CLOSED at
 * the database, not just in application filters (docs/security-fixes.md, P0
 * "make database tenant isolation fail closed").
 *
 * Setup mirrors production: tables owned by the migration role, a non-owner
 * application role (like `specboard_app`) granted DML but constrained by the
 * RLS policies from migrations 0002/0012+, and `DbStore` connecting as that
 * role. Two workspaces with one member each; every assertion tries to reach
 * across the boundary and must come back empty-handed.
 *
 * Needs a migrated Postgres at DATABASE_URL (CI's service container, or a
 * local disposable postgres:16). Skips itself when no database is configured.
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

/** Seeded fixture ids (uuids generated per run; rows cleaned up in afterAll). */
const ws = { a: randomUUID(), b: randomUUID() };
const user = { alice: randomUUID(), bob: randomUUID() };
const spec = { a: randomUUID(), b: randomUUID() };
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!OWNER_URL)("RLS tenant isolation (two-tenant)", () => {
  let owner: postgres.Sql;
  let app: postgres.Sql;
  let store: DbStore;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });

    // Non-owner app role, provisioned the way infra/rls-role.sql does it.
    // Idempotent: the role and grants survive across runs.
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

    // Two tenants: alice owns workspace A, bob owns workspace B.
    await owner`insert into workspaces (id, name, slug) values
      (${ws.a}, 'Tenant A', ${"rls-int-a-" + suffix}),
      (${ws.b}, 'Tenant B', ${"rls-int-b-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.alice}, 'Alice', ${`alice-${suffix}@rls.test`}),
      (${user.bob}, 'Bob', ${`bob-${suffix}@rls.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws.a}, ${user.alice}, 'owner'),
      (${ws.b}, ${user.bob}, 'owner')`;
    // features.level carries a composite FK to workspace_levels.
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws.a}, 'work', 'Work Items', 0, true),
      (${ws.b}, 'work', 'Work Items', 0, true)`;
    await owner`insert into features (spec_id, workspace_id, title) values
      (${spec.a}, ${ws.a}, 'A: checkout flow'),
      (${spec.b}, ${ws.b}, 'B: billing engine')`;
    await owner`insert into products (workspace_id, key, name) values
      (${ws.a}, 'alpha', 'Alpha'),
      (${ws.b}, 'beta', 'Beta')`;
    await owner`insert into repositories (workspace_id, github_installation_id, owner, name, default_branch) values
      (${ws.a}, 'rls-int-install-a', 'tenant-a', 'specs', 'main'),
      (${ws.b}, 'rls-int-install-b', 'tenant-b', 'specs', 'main')`;

    app = postgres(appUrlFrom(OWNER_URL!), { prepare: false, max: 2 });
    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    // Workspace cascade clears members/features/products/repositories.
    await owner`delete from workspaces where id in (${ws.a}, ${ws.b})`;
    await owner`delete from users where id in (${user.alice}, ${user.bob})`;
    await owner.end({ timeout: 5 });
    await app?.end({ timeout: 5 });
  });

  /** Run `fn` on the app connection with `userId` as the RLS context. */
  async function asUser<T>(
    userId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return app.begin(async (tx) => {
      if (userId) {
        await tx`select set_config('app.user_id', ${userId}, true)`;
      }
      return fn(tx);
    }) as Promise<T>;
  }

  it("verifies the app role connection is RLS-safe and the owner one is not", async () => {
    const appProbe = await probeTenantConnection(appUrlFrom(OWNER_URL!));
    expect(tenantIsolationViolations(appProbe)).toEqual([]);

    const ownerProbe = await probeTenantConnection(OWNER_URL!);
    expect(tenantIsolationViolations(ownerProbe)).not.toEqual([]);
  });

  it("store reads return only the scoped tenant's rows", async () => {
    const features = await store.listFeatures({ userId: user.alice, workspaceId: ws.a });
    expect(features.map((f) => f.title)).toEqual(["A: checkout flow"]);

    const products = await store.listProducts({ userId: user.alice, workspaceId: ws.a });
    expect(products.map((p) => p.key)).toContain("alpha");
    expect(products.map((p) => p.key)).not.toContain("beta");
  });

  it("a scope for a workspace the user is not a member of sees nothing", async () => {
    // Alice claims workspace B: membership fails at the RLS layer, so even a
    // correctly-parameterized query comes back empty instead of leaking.
    const features = await store.listFeatures({ userId: user.alice, workspaceId: ws.b });
    expect(features).toEqual([]);
    const products = await store.listProducts({ userId: user.alice, workspaceId: ws.b });
    expect(products).toEqual([]);
  });

  it("cross-tenant writes and deletes do not land", async () => {
    // Alice tries to modify and delete Bob's feature under both plausible
    // buggy scopes. Whether the store throws or no-ops, the row must survive
    // unchanged; that invariant is what matters.
    const attempts = [
      { userId: user.alice, workspaceId: ws.b },
      { userId: user.alice, workspaceId: ws.a },
    ];
    for (const scope of attempts) {
      await store.updateFeature(spec.b, { title: "pwned" }, scope).catch(() => {});
      await store.deleteFeature(spec.b, scope).catch(() => {});
    }
    const [row] = await owner`select title from features where spec_id = ${spec.b}`;
    expect(row?.title).toBe("B: billing engine");
  });

  it("an unscoped store call is refused outright", async () => {
    await expect(store.listFeatures(undefined)).rejects.toThrow(/workspace scope/i);
  });

  it("a query with no RLS context sees zero tenant rows (fail closed)", async () => {
    // The intentionally-unscoped query from the acceptance criteria: on the
    // app connection with no app.user_id set, tenant tables must act empty.
    const noContext = await asUser(null, (tx) => tx`select count(*)::int as n from features`);
    expect(noContext[0]?.n).toBe(0);

    const viaOwner = await owner`select count(*)::int as n from features`;
    expect(viaOwner[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("a workspace-unfiltered query still only returns the member's tenant", async () => {
    // Simulates the exact bug RLS exists to backstop: application code that
    // forgot the workspaceId predicate entirely.
    const rows = await asUser(user.alice, (tx) => tx`select title from features`);
    expect(rows.map((r) => r.title)).toEqual(["A: checkout flow"]);

    const repos = await asUser(user.alice, (tx) => tx`select owner from repositories`);
    expect(repos.map((r) => r.owner)).toEqual(["tenant-a"]);
  });

  it("inserting into another tenant's workspace is rejected by policy", async () => {
    await expect(
      asUser(user.alice, (tx) =>
        tx`insert into features (spec_id, workspace_id, title)
           values (${randomUUID()}, ${ws.b}, 'smuggled')`,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
    const [row] = await owner`select count(*)::int as n from features where workspace_id = ${ws.b}`;
    expect(row?.n).toBe(1);
  });
});
