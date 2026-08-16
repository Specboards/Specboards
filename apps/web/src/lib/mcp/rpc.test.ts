import { describe, expect, it } from "vitest";

import { handleMcpMessage, toolAllowedByScope, type McpAuth } from "./rpc";
import { TOOLS } from "./tools";
import { type McpContext, type McpTool } from "./types";

/**
 * The scope gate on `/api/mcp`.
 *
 * The hole this covers: scope enforcement used to be derived from the request
 * path (`/api/v1/<resource>`), and `/api/mcp` matches nothing, so a restricted
 * key sailed through and the only remaining check was "do you belong to a
 * workspace". A key scoped `features:read` could call `create_item`,
 * `delete_item` and `update_spec_content` at its owner's full authority.
 *
 * Nothing here touches the database: `toolAllowedByScope` runs before
 * `tool.run`, so a denial is observable without a store.
 */

function ctx(scopes: string[], over: Partial<McpContext> = {}): McpContext {
  return {
    scope: { userId: "user-1", workspaceId: "ws-1" },
    role: "member",
    isLocal: false,
    scopes,
    // No credential key: these cases assert the scope gate, which runs before
    // any quota, and a null key keeps the rate limiter out of the way.
    credentialKey: null,
    // Default to allowed, so these cases keep asserting the scope gate alone.
    // The destructive gate has its own describe block below.
    allowDestructive: true,
    ...over,
  };
}

function authed(scopes: string[], over: Partial<McpContext> = {}): McpAuth {
  return { ok: true, ctx: ctx(scopes, over) };
}

const tool = (name: string): McpTool => {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

/** Call a tool over the JSON-RPC surface and return the text of its result. */
async function call(name: string, auth: McpAuth): Promise<string> {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } },
    auth,
  );
  const result = res?.result as { content: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? "";
}

async function listedTools(auth: McpAuth): Promise<string[]> {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    auth,
  );
  return ((res?.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
}

describe("toolAllowedByScope", () => {
  it("refuses every write tool to a read-only key on that resource", () => {
    const readOnly = ctx(["features:read"]);
    for (const name of [
      "create_item",
      "update_item",
      "delete_item",
      "update_spec_content",
      "link_github",
      "unlink_github",
    ]) {
      expect(toolAllowedByScope(tool(name), readOnly), name).toBe(false);
    }
  });

  it("still allows the reads that key was granted", () => {
    const readOnly = ctx(["features:read"]);
    for (const name of ["list_items", "read_item", "get_relations", "list_github_links"]) {
      expect(toolAllowedByScope(tool(name), readOnly), name).toBe(true);
    }
  });

  it("does not let a write scope on one resource reach another", () => {
    const featureWriter = ctx(["features:write"]);
    expect(toolAllowedByScope(tool("update_item"), featureWriter)).toBe(true);
    for (const name of [
      "create_release",
      "update_goal",
      "create_cycle",
      "create_doc",
      "delete_doc",
      "create_key_result",
      "create_spec",
    ]) {
      expect(toolAllowedByScope(tool(name), featureWriter), name).toBe(false);
    }
  });

  it("treats write as implying read on the same resource", () => {
    const writer = ctx(["goals:write"]);
    expect(toolAllowedByScope(tool("list_goals"), writer)).toBe(true);
    expect(toolAllowedByScope(tool("read_goal"), writer)).toBe(true);
    expect(toolAllowedByScope(tool("delete_goal"), writer)).toBe(true);
  });

  it("leaves unrestricted credentials alone", () => {
    // Empty scopes: browser session, OAuth token, or a legacy pre-scopes key.
    // All three keep the access they had before scopes existed.
    for (const t of TOOLS) {
      expect(toolAllowedByScope(t, ctx([])), t.name).toBe(true);
      expect(toolAllowedByScope(t, ctx(["*"])), t.name).toBe(true);
    }
  });

  it("leaves local file mode alone", () => {
    const local = ctx([], { scope: undefined, role: null, isLocal: true });
    for (const t of TOOLS) {
      expect(toolAllowedByScope(t, local), t.name).toBe(true);
    }
  });
});

describe("tools/call", () => {
  it("names the missing scope rather than failing vaguely", async () => {
    const text = await call("create_item", authed(["features:read"]));
    expect(text).toContain("features:write");
    expect(text).toContain("create_item");
  });

  it("refuses a tool the key was never offered in tools/list", async () => {
    // A client can call any name it likes; filtering the listing is a courtesy,
    // not the gate.
    const auth = authed(["features:read"]);
    expect(await listedTools(auth)).not.toContain("delete_item");
    expect(await call("delete_item", auth)).toContain("features:write");
  });

  it("checks scope before the workspace-membership write gate", async () => {
    // Order matters for the message the agent sees: a scope problem should say
    // "your key lacks X", not "you must belong to a workspace".
    const noWorkspace: McpAuth = {
      ok: true,
      ctx: ctx(["features:read"], { scope: undefined, role: null }),
    };
    expect(await call("create_item", noWorkspace)).toContain("features:write");
  });
});

describe("tools/list", () => {
  it("advertises only what a restricted key may call", async () => {
    const names = await listedTools(authed(["features:read", "docs:write"]));
    expect(names).toEqual(
      expect.arrayContaining(["list_items", "read_item", "list_docs", "create_doc"]),
    );
    for (const hidden of [
      "create_item",
      "delete_item",
      "create_release",
      "update_goal",
    ]) {
      expect(names, hidden).not.toContain(hidden);
    }
  });

  it("advertises everything to an unrestricted credential", async () => {
    expect(await listedTools(authed([]))).toHaveLength(TOOLS.length);
  });

  it("advertises everything when the caller is unauthenticated", async () => {
    // The 401 challenge is the route's job; an unauthenticated client still
    // needs to see the surface it is being asked to sign in for.
    const anon: McpAuth = { ok: false, unauthenticated: true, message: "nope" };
    expect(await listedTools(anon)).toHaveLength(TOOLS.length);
  });
});
