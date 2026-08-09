import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end proof that a restricted API key cannot write through `/api/mcp`.
 *
 * The unit tests in `rpc.test.ts` hand `handleMcpMessage` a context they built
 * themselves, so they verify the gate but not the plumbing that fills it. This
 * one mints a real `sb_` key with real scopes in Postgres, puts it on a real
 * Request, and drives `resolveMcpAuth` -> `handleMcpMessage`. That is the whole
 * path the bypass lived in: the key verified fine, the scope check was skipped
 * because `/api/mcp` matched no `/api/v1/<resource>` pattern, and the write
 * tools ran.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const workspace = { id: randomUUID(), slug: `mcpscope-${randomUUID().slice(0, 8)}` };
const userId = randomUUID();

describe.skipIf(!DB_URL)("MCP scope enforcement with a real API key", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let readOnlyKey: string;
  let writeKey: string;
  let legacyKey: string;
  let resolveMcpAuth: typeof import("./rpc").resolveMcpAuth;
  let handleMcpMessage: typeof import("./rpc").handleMcpMessage;

  /** A request as an MCP client makes it: bearer key, explicit org. */
  function request(key: string): Request {
    return new Request("https://app.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-org-slug": workspace.slug },
    });
  }

  /** Call `tool` with `key` and return the text the agent would see. */
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

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    ({ resolveMcpAuth, handleMcpMessage } = await import("./rpc"));

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${workspace.id}, 'MCP Scope', ${workspace.slug})`;
    await sql`insert into users (id, name, email)
      values (${userId}, 'Agent Owner', ${`agent-${workspace.slug}@scope.test`})`;
    // Owner, so nothing below is refused for lack of product write access: the
    // only thing that may stop these calls is the key's scope.
    await sql`insert into members (workspace_id, user_id, role)
      values (${workspace.id}, ${userId}, 'owner')`;

    const { createApiKey } = await import("@/lib/api-keys");
    readOnlyKey = (await createApiKey(db, userId, "read-only", null, ["features:read"]))
      .key;
    writeKey = (await createApiKey(db, userId, "writer", null, ["features:write"])).key;
    // Empty scopes: a key minted before scopes existed. Must keep full access.
    legacyKey = (await createApiKey(db, userId, "legacy", null, [])).key;
  });

  afterAll(async () => {
    await sql`delete from api_keys where user_id = ${userId}`;
    await sql`delete from members where workspace_id = ${workspace.id}`;
    await sql`delete from workspaces where id = ${workspace.id}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("authenticates the restricted key", async () => {
    const auth = await resolveMcpAuth(request(readOnlyKey));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx.scopes).toEqual(["features:read"]);
    expect(auth.ctx.role).toBe("owner");
  });

  it("refuses the write tools to a features:read key", async () => {
    for (const tool of ["create_item", "update_item", "delete_item", "create_spec"]) {
      const text = await callTool(readOnlyKey, tool);
      expect(text, tool).toContain("scope");
      // The message must name what is missing, not just say no.
      expect(text, tool).toMatch(/features:write|specs:write/);
    }
  });

  it("still lets that key read", async () => {
    const text = await callTool(readOnlyKey, "list_items");
    expect(text).not.toContain("lacks the");
  });

  it("lets a features:write key write items but not releases or goals", async () => {
    const listed = await callTool(writeKey, "list_items");
    expect(listed).not.toContain("lacks the");
    for (const tool of ["create_release", "update_goal", "create_doc"]) {
      expect(await callTool(writeKey, tool), tool).toContain("lacks the");
    }
  });

  it("leaves a legacy full-access key unrestricted", async () => {
    const auth = await resolveMcpAuth(request(legacyKey));
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.ctx.scopes).toEqual([]);
    // Not asserting the call succeeds (it needs valid arguments); asserting it
    // is not turned away at the scope gate, which is the property under test.
    expect(await callTool(legacyKey, "create_item")).not.toContain("lacks the");
  });

  it("advertises only the permitted tools to a restricted key", async () => {
    const auth = await resolveMcpAuth(request(readOnlyKey));
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      auth,
    );
    const names = ((res?.result as { tools: { name: string }[] }).tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toContain("list_items");
    expect(names).not.toContain("create_item");
    expect(names).not.toContain("update_spec_content");
  });
});
