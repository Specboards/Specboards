import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Agent identities end to end: creating one, what its key can actually reach
 * over `/api/mcp`, rotating it, and revoking it.
 *
 * The behaviour worth pinning down is the grant policy. Service accounts were
 * built for the `specboards-sync` CI bot, where omitting `productGrants` means
 * "contributor on every product in the workspace". That default is right for
 * that bot and wrong for a customer's agent, so the Settings path always sends
 * an explicit list. Both readings are asserted here, because the difference
 * between them is silent: an agent created the wrong way looks identical in the
 * UI and can write to products nobody meant to give it.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `agents-${suffix}` };
const ownerId = randomUUID();
const productA = randomUUID();
const productB = randomUUID();

describe.skipIf(!DB_URL)("agent identities", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./service-accounts-service");
  let resolveMcpAuth: typeof import("./mcp/rpc").resolveMcpAuth;
  let handleMcpMessage: typeof import("./mcp/rpc").handleMcpMessage;

  const scope = () => ({ userId: ownerId, workspaceId: workspace.id });

  function request(key: string): Request {
    return new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-org-slug": workspace.slug },
    });
  }

  async function callTool(key: string, tool: string): Promise<string> {
    const auth = await resolveMcpAuth(request(key));
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: {} },
      },
      auth,
    );
    const result = res?.result as { content?: { text: string }[] } | undefined;
    return result?.content?.[0]?.text ?? "";
  }

  /** Product ids the agent holds any grant on, straight from the table. */
  async function grantedProducts(userId: string): Promise<string[]> {
    const rows = await sql<{ product_id: string }[]>`
      select product_id from product_members
      where workspace_id = ${workspace.id} and user_id = ${userId}`;
    return rows.map((r) => r.product_id).sort();
  }

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./service-accounts-service");
    ({ resolveMcpAuth, handleMcpMessage } = await import("./mcp/rpc"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Agents', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${ownerId}, 'Owner', ${`owner-${suffix}@agents.test`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${ownerId}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${productA}, ${workspace.id}, ${`atlas-${suffix}`}, 'Atlas'),
      (${productB}, ${workspace.id}, ${`beacon-${suffix}`}, 'Beacon')`;
  });

  afterAll(async () => {
    const bots = await sql<{ user_id: string }[]>`
      select user_id from members
      where workspace_id = ${workspace.id} and role = 'service'`;
    const ids = [...bots.map((b) => b.user_id), ownerId];
    await sql`delete from api_keys where user_id in ${sql(ids)}`;
    await sql`delete from product_members where workspace_id = ${workspace.id}`;
    await sql`delete from products where workspace_id = ${workspace.id}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id in ${sql(ids)}`;
    await sql.end({ timeout: 5 });
  });

  it("grants only the products named when the list is explicit", async () => {
    const { account, key } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "Explicit agent",
        scopes: ["features:read"],
        expiresInDays: 90,
        grantPolicy: {
          kind: "explicit",
          grants: [{ productId: productA, role: "contributor" }],
        },
      },
      scope(),
    );

    expect(await grantedProducts(account.userId)).toEqual([productA]);
    expect(key.key.startsWith("sb_")).toBe(true);
    expect(account.scopes).toEqual(["features:read"]);
  });

  it("grants nothing for an explicitly empty list", async () => {
    // The case the Settings UI sends when no product is ticked. It must mean
    // "no products", not "unspecified, so all of them".
    const { account } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "Ungranted agent",
        scopes: ["features:read"],
        expiresInDays: null,
        grantPolicy: { kind: "explicit", grants: [] },
      },
      scope(),
    );
    expect(await grantedProducts(account.userId)).toEqual([]);
  });

  it("still sweeps every product for the legacy CI-bot policy", async () => {
    // docs/RUNBOOK-specboard-dogfood.md documents a curl with no productGrants.
    // That has to keep working, which is why the sweep survives as a policy.
    const { account } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "CI sync bot",
        scopes: ["features:write"],
        expiresInDays: null,
        grantPolicy: { kind: "every-product-contributor" },
      },
      scope(),
    );
    expect(await grantedProducts(account.userId)).toEqual(
      [productA, productB].sort(),
    );
  });

  it("maps an omitted productGrants to the sweep and a given one to explicit", () => {
    expect(
      svc.parseCreateServiceAccountInput({ name: "bot" }).grantPolicy,
    ).toEqual({ kind: "every-product-contributor" });
    expect(
      svc.parseCreateServiceAccountInput({ name: "bot", productGrants: [] })
        .grantPolicy,
    ).toEqual({ kind: "explicit", grants: [] });
  });

  it("authenticates over /api/mcp and is held to its scopes", async () => {
    const { key } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "Reader agent",
        scopes: ["features:read"],
        expiresInDays: null,
        grantPolicy: { kind: "explicit", grants: [] },
      },
      scope(),
    );

    const auth = await resolveMcpAuth(request(key.key));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx.scopes).toEqual(["features:read"]);
    // A service member, not an owner: it cannot inherit its creator's role.
    expect(auth.ctx.role).toBe("service");

    expect(await callTool(key.key, "list_items")).not.toContain("lacks the");
    expect(await callTool(key.key, "create_item")).toContain("features:write");
  });

  it("rotates to a new key, keeping the scopes and killing the old one", async () => {
    const { account, key } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "Rotating agent",
        scopes: ["features:read", "specs:read"],
        expiresInDays: null,
        grantPolicy: { kind: "explicit", grants: [] },
      },
      scope(),
    );

    const rotated = await svc.rotateServiceAccountKey(
      db,
      workspace.id,
      account.userId,
      90,
    );
    expect(rotated.key).not.toBe(key.key);
    // Rotation is a credential operation, not a re-authorization.
    expect(rotated.scopes).toEqual(["features:read", "specs:read"]);
    expect(rotated.expiresAt).not.toBeNull();

    const oldAuth = await resolveMcpAuth(request(key.key));
    expect(oldAuth.ok).toBe(false);
    const newAuth = await resolveMcpAuth(request(rotated.key));
    expect(newAuth.ok).toBe(true);
  });

  it("stops a revoked agent on its next call, but keeps it attributable", async () => {
    const { account, key } = await svc.createServiceAccount(
      db,
      workspace.id,
      {
        name: "Doomed agent",
        scopes: ["features:read"],
        expiresInDays: null,
        grantPolicy: {
          kind: "explicit",
          grants: [{ productId: productA, role: "contributor" }],
        },
      },
      scope(),
    );
    expect((await resolveMcpAuth(request(key.key))).ok).toBe(true);

    await svc.revokeServiceAccount(db, workspace.id, account.userId);

    expect((await resolveMcpAuth(request(key.key))).ok).toBe(false);
    expect(await grantedProducts(account.userId)).toEqual([]);
    const [membership] = await sql`
      select 1 from members
      where workspace_id = ${workspace.id} and user_id = ${account.userId}`;
    expect(membership).toBeUndefined();
    // The users row survives, or every edit the agent ever made would render as
    // an unattributed "Someone" in item history.
    const [user] = await sql`select name from users where id = ${account.userId}`;
    expect(user).toMatchObject({ name: "Doomed agent" });
  });

  it("refuses to revoke or rotate anything that is not one of its agents", async () => {
    // A human member's id, and a well-formed id belonging to nothing.
    for (const target of [ownerId, randomUUID()]) {
      await expect(
        svc.revokeServiceAccount(db, workspace.id, target),
      ).rejects.toThrow(/No such agent/);
      await expect(
        svc.rotateServiceAccountKey(db, workspace.id, target, null),
      ).rejects.toThrow(/No such agent/);
    }
  });

  it("lists agents with their scopes, grants and key", async () => {
    const listed = await svc.listServiceAccounts(db, workspace.id);
    const explicit = listed.find((a) => a.name === "Explicit agent");
    expect(explicit).toBeDefined();
    expect(explicit!.scopes).toEqual(["features:read"]);
    expect(explicit!.productGrants).toEqual([
      { productId: productA, role: "contributor" },
    ]);
    expect(explicit!.key?.prefix.startsWith("sb_")).toBe(true);
    expect(explicit!.key?.expiresAt).not.toBeNull();

    // Revoked agents drop out of the listing entirely (no membership row).
    expect(listed.some((a) => a.name === "Doomed agent")).toBe(false);
  });
});
