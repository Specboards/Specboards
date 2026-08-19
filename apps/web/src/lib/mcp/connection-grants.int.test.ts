import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What an OAuth-connected agent may actually do, driven through the real
 * resolver with real token rows.
 *
 * The hole this closes: `resolveMcpAuth` returned `scopes: []` for every OAuth
 * connection, and `[]` means UNRESTRICTED in `keyScopesSatisfy`, so a connected
 * agent could do everything its authorising user could, `delete_item` included,
 * with no way to narrow it and no per-connection revocation.
 *
 * The migration case is the one that most needs a test. It was first written to
 * assert the opposite of what it asserts now: a connection made before consent
 * asked has NULL scopes, and those were read as `[]` so that live agents kept
 * working. That preserved access nobody had granted, against a tool registry
 * that kept growing, and measurement later showed every connection in production
 * was in exactly that state - so the consent feature governed none of them. The
 * absent answer is now refused rather than trusted, and the connection is
 * retired so its next call goes back through consent.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.BETTER_AUTH_SECRET ||= "int-test-secret-at-least-32-chars-long!!";

const suffix = randomUUID().slice(0, 8);
const workspace = { id: randomUUID(), slug: `grant-${suffix}` };
const userId = randomUUID();

/** One client per grant shape, so each keeps an independent binding row. */
const clients = {
  legacy: `grant-legacy-${suffix}`,
  read: `grant-read-${suffix}`,
  author: `grant-author-${suffix}`,
  full: `grant-full-${suffix}`,
};
const tokens = Object.fromEntries(
  Object.keys(clients).map((k) => [k, `grant-token-${k}-${randomUUID()}`]),
) as Record<keyof typeof clients, string>;

describe.skipIf(!DB_URL)("OAuth connection grants", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let binding: typeof import("./workspace-binding");
  let grants: typeof import("./connection-grants");
  let resolveMcpAuth: typeof import("./rpc").resolveMcpAuth;
  let handleMcpMessage: typeof import("./rpc").handleMcpMessage;

  function request(token: string): Request {
    return new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function callTool(token: string, tool: string): Promise<string> {
    const auth = await resolveMcpAuth(request(token));
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

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    binding = await import("./workspace-binding");
    grants = await import("./connection-grants");
    ({ resolveMcpAuth, handleMcpMessage } = await import("./rpc"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'Grants', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Connector', ${`connector-${suffix}@grant.test`})`;
    // Owner, so nothing below is refused for lack of product write access: the
    // only thing that may stop these calls is the connection's grant.
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;

    const expires = new Date(Date.now() + 3_600_000);
    for (const [key, clientId] of Object.entries(clients)) {
      await sql`insert into oauth_applications (client_id, name, redirect_urls, type)
        values (${clientId}, ${`Agent ${key}`}, 'http://localhost/cb', 'public')`;
      const token = tokens[key as keyof typeof clients];
      await sql`insert into oauth_access_tokens
          (access_token, refresh_token, access_token_expires_at,
           refresh_token_expires_at, client_id, user_id, scopes)
        values (${token}, ${`${token}-r`}, ${expires}, ${expires},
                ${clientId}, ${userId}, '')`;
    }

    // The legacy connection: a binding row written before consent asked, so its
    // scopes are NULL and allow_destructive sits at the column default.
    await sql`insert into mcp_workspace_bindings (user_id, client_id, workspace_id)
      values (${userId}, ${clients.legacy}, ${workspace.id})`;

    // The three new-style connections, recorded the way consent records them.
    for (const id of ["read", "author", "full"] as const) {
      const grant = grants.connectionGrantById(id);
      await binding.recordMcpWorkspaceBinding(db, {
        userId,
        clientId: clients[id],
        workspaceId: workspace.id,
        grant: { scopes: grant.scopes, allowDestructive: grant.allowDestructive },
      });
    }
  });

  afterAll(async () => {
    await sql`delete from mcp_workspace_bindings where user_id = ${userId}`;
    await sql`delete from oauth_access_tokens where user_id = ${userId}`;
    await sql`delete from oauth_applications where client_id in ${sql(
      Object.values(clients),
    )}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("refuses a connection that carries no recorded grant, and retires it", async () => {
    const auth = await resolveMcpAuth(request(tokens.legacy));
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    // `unauthenticated` is what makes the route answer 401 + WWW-Authenticate,
    // which is what makes an OAuth-capable client restart the flow instead of
    // surfacing a dead error. A 403 here would leave the agent stuck.
    expect(auth.unauthenticated).toBe(true);
    expect(auth.message).toMatch(/reconnect/i);

    // Retired, not merely refused: the binding, the tokens and the recorded
    // consent all go, because leaving the consent row lets the authorize
    // endpoint answer from the stored decision and hand back a fresh token
    // without asking anyone, which would put the connection straight back here.
    const [bindingRow] = await sql`select 1 from mcp_workspace_bindings
      where user_id = ${userId} and client_id = ${clients.legacy}`;
    expect(bindingRow).toBeUndefined();
    const [tokenRow] = await sql`select 1 from oauth_access_tokens
      where user_id = ${userId} and client_id = ${clients.legacy}`;
    expect(tokenRow).toBeUndefined();
    const [consentRow] = await sql`select 1 from oauth_consents
      where user_id = ${userId} and client_id = ${clients.legacy}`;
    expect(consentRow).toBeUndefined();
  });

  it("refuses an OAuth token with no binding row at all", async () => {
    // The authorize flow can complete without the grant POST landing, which
    // left a token resolving to unrestricted access off the back of a row that
    // does not exist. Absent is absent either way.
    const orphan = `grant-token-orphan-${randomUUID()}`;
    const expires = new Date(Date.now() + 3_600_000);
    await sql`insert into oauth_applications
        (client_id, name, redirect_urls, type, disabled, user_id)
      values (${`grant-orphan-${suffix}`}, 'Agent orphan', '', 'public', false, ${userId})`;
    await sql`insert into oauth_access_tokens
        (access_token, refresh_token, access_token_expires_at,
         refresh_token_expires_at, client_id, user_id, scopes)
      values (${orphan}, ${`${orphan}-r`}, ${expires}, ${expires},
              ${`grant-orphan-${suffix}`}, ${userId}, '')`;

    const auth = await resolveMcpAuth(request(orphan));
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.unauthenticated).toBe(true);

    await sql`delete from oauth_applications where client_id = ${`grant-orphan-${suffix}`}`;
  });

  it("holds a read-only connection to reads", async () => {
    const auth = await resolveMcpAuth(request(tokens.read));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx.scopes).toContain("features:read");
    expect(auth.ctx.scopes).not.toContain("features:write");

    expect(await callTool(tokens.read, "list_items")).not.toContain("lacks the");
    expect(await callTool(tokens.read, "create_item")).toContain(
      "features:write",
    );
  });

  it("lets an authoring connection write but not delete", async () => {
    expect(await callTool(tokens.author, "create_item")).not.toContain(
      "lacks the",
    );
    const refused = await callTool(tokens.author, "delete_item");
    expect(refused).toContain("deletes data");
    // The message has to point at the fix, which is reconsenting, not at a
    // scope the user cannot add from anywhere.
    expect(refused).toContain("reconnect");
  });

  it("leaves a full-access connection able to delete", async () => {
    expect(await callTool(tokens.full, "delete_item")).not.toContain(
      "not granted",
    );
  });

  it("hides the tools a connection may not call from tools/list", async () => {
    const auth = await resolveMcpAuth(request(tokens.author));
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      auth,
    );
    const names = ((res?.result as { tools: { name: string }[] }).tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toContain("create_item");
    expect(names).toContain("update_item");
    expect(names).not.toContain("delete_item");
    expect(names).not.toContain("delete_goal");
  });

  it("records when a connection last called", async () => {
    const before = await binding.listMcpConnections(db, userId);
    expect(before.find((c) => c.clientId === clients.read)?.lastUsedAt).not.toBe(
      null,
    );
    // The legacy connection is deliberately absent: the first test retired it.
    // A NULL-scoped row surviving here would mean the refusal did not stick.
    expect(before.find((c) => c.clientId === clients.legacy)).toBeUndefined();
    expect(before.every((c) => c.scopes !== null)).toBe(true);
  });

  it("lists a user's connections with what each was granted", async () => {
    const listed = await binding.listMcpConnections(db, userId);
    // Three, not four: the legacy connection was retired by the first test.
    expect(listed).toHaveLength(3);
    const author = listed.find((c) => c.clientId === clients.author)!;
    expect(author.workspaceName).toBe("Grants");
    expect(author.allowDestructive).toBe(false);
    expect(
      grants.describeStoredGrant(author.scopes, author.allowDestructive),
    ).toBe("Read and author");
  });

  it("revokes a connection: tokens, consent and binding all go", async () => {
    expect(await binding.revokeMcpConnection(db, userId, clients.full)).toBe(
      true,
    );

    // Stops on the next call: the access token row is gone, so the bearer no
    // longer resolves to anyone.
    expect((await resolveMcpAuth(request(tokens.full))).ok).toBe(false);
    const listed = await binding.listMcpConnections(db, userId);
    expect(listed.some((c) => c.clientId === clients.full)).toBe(false);

    // Revoking something already gone is not an error the caller must handle
    // differently, but it does report that nothing was there.
    expect(await binding.revokeMcpConnection(db, userId, clients.full)).toBe(
      false,
    );
  });

  it("does not let one user revoke another's connection", async () => {
    expect(
      await binding.revokeMcpConnection(db, randomUUID(), clients.read),
    ).toBe(false);
    // Still there.
    const listed = await binding.listMcpConnections(db, userId);
    expect(listed.some((c) => c.clientId === clients.read)).toBe(true);
  });
});
