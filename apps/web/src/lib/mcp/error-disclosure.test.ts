import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureError } from "@/lib/store/types";

import { McpToolError, requireUuid, type McpTool } from "./types";

/**
 * What a failed tool call is allowed to tell the caller.
 *
 * The hole this covers: the catch in `handleToolCall` returned
 * `(err as Error).message` for anything that was not a timeout. Drizzle builds
 * `DrizzleQueryError`'s message as ``Failed query: ${query}\nparams: ${params}``
 * so a query Postgres rejected handed the connected agent the whole statement
 * and every bound parameter - the schema, and the workspace id.
 *
 * The easiest way in was a `specId` that is not a valid UUID, because
 * `features.spec_id` is a `uuid` column and an abbreviated id is exactly the
 * mistake an agent makes with a value this long. That path is now rejected
 * before Postgres sees it, and the boundary withholds internal errors besides.
 *
 * `./tools` is mocked so failures can be provoked without a database.
 */

/**
 * Stands in for drizzle's `DrizzleQueryError`, whose message is built as
 * ``Failed query: ${query}\nparams: ${params}``. Reproduced rather than
 * imported because `drizzle-orm` is a dependency of `@specboards/db`, not of
 * this app; what is under test is how the boundary treats a message of this
 * shape, not drizzle itself.
 */
class FakeDrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
    this.name = "DrizzleQueryError";
  }
}

/** The statement and parameters actually observed leaking, trimmed to fit. */
const LEAKED_QUERY =
  'select "features"."id", "features"."spec_id", "features"."workspace_id" ' +
  'from "features" "features" left join lateral (select "features_index"."data" ' +
  'from "spec_index" "features_index") "features_index" on true ' +
  'where ("features"."spec_id" = $2 and "features"."workspace_id" = $3)';
const WORKSPACE_ID = "c7423ed2-ff4b-46be-b4e4-e69e8af454ba";

function tool(name: string, run: McpTool["run"]): McpTool {
  return {
    name,
    description: `Fails on purpose (${name}).`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "features", action: "read" },
    run,
  } as McpTool;
}

const TOOLS: McpTool[] = [
  tool("db_error", () => {
    throw new FakeDrizzleQueryError(LEAKED_QUERY, [
      1,
      "7f053ebc",
      WORKSPACE_ID,
      1,
    ]);
  }),
  tool("bare_error", () => {
    throw new Error(
      "ENOENT: no such file or directory, open '/app/.next/server/secret.js'",
    );
  }),
  tool("tool_error", () => {
    throw new McpToolError(
      "No item with spec id 7f053ebc-0000-0000-0000-000000000000.",
    );
  }),
  tool("domain_error", () => {
    throw new FeatureError('Level "epic" cannot be a child of "feature".');
  }),
  tool("thrown_string", () => {
    throw "not even an error";
  }),
];

vi.mock("./tools", () => ({ TOOLS }));

const { handleMcpMessage } = await import("./rpc");

function auth() {
  return {
    ok: true as const,
    ctx: {
      scope: { userId: "user-1", workspaceId: WORKSPACE_ID },
      role: "owner" as const,
      isLocal: false,
      // Unrestricted, so nothing but the failure itself is under test.
      scopes: [],
      credentialKey: null,
      allowDestructive: true,
    },
  };
}

async function callTool(name: string): Promise<string> {
  const res = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    },
    auth(),
  );
  const result = res?.result as { content?: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("what a failed tool call discloses", () => {
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("withholds the SQL and bound parameters of a driver error", async () => {
    const text = await callTool("db_error");
    // The specific things that were leaking, each asserted separately so a
    // regression names which one came back.
    expect(text).not.toContain("Failed query");
    expect(text).not.toContain("select ");
    expect(text).not.toContain("spec_index");
    expect(text).not.toContain("features");
    expect(text).not.toContain("params:");
    // The workspace id is the worst of it: a tenant identifier in an error
    // surface that no tenant check governs.
    expect(text).not.toContain(WORKSPACE_ID);
  });

  it("gives the caller a reference id it can quote instead", async () => {
    const text = await callTool("db_error");
    const ref = /reference ([0-9a-f]{8})/.exec(text);
    expect(ref).not.toBeNull();
    // Two failures must not share a handle, or the logs cannot be matched up.
    const second = /reference ([0-9a-f]{8})/.exec(await callTool("db_error"));
    expect(second?.[1]).not.toBe(ref?.[1]);
  });

  it("still logs the real error, tagged with that same reference", async () => {
    const text = await callTool("db_error");
    const ref = /reference ([0-9a-f]{8})/.exec(text)?.[1];
    const logged = info.mock.calls.map((c) => String(c[0])).join("\n");
    // Withholding it from the caller is the point; withholding it from us
    // would just make the bug unfindable. `logMcpCall` collapses whitespace so
    // each call stays one greppable line, hence `Failed_query`.
    expect(logged).toContain("Failed_query");
    expect(logged).toContain("spec_index");
    expect(logged).toContain(`ref=${ref}`);
    expect(logged).toContain("errType=DrizzleQueryError");
  });

  it("withholds a bare Error, which is how library faults arrive", async () => {
    const text = await callTool("bare_error");
    expect(text).not.toContain("ENOENT");
    expect(text).not.toContain("/app/.next");
    expect(text).toMatch(/reference [0-9a-f]{8}/);
  });

  it("survives a thrown non-Error without disclosing it", async () => {
    const text = await callTool("thrown_string");
    expect(text).not.toContain("not even an error");
    expect(text).toMatch(/reference [0-9a-f]{8}/);
  });

  it("passes a tool's own message through unchanged", async () => {
    // The agent needs these verbatim to correct itself, so the fix must not
    // have flattened them into the generic text.
    const text = await callTool("tool_error");
    expect(text).toContain(
      "No item with spec id 7f053ebc-0000-0000-0000-000000000000.",
    );
    expect(text).not.toMatch(/reference [0-9a-f]{8}/);
  });

  it("passes a service-layer domain error through unchanged", async () => {
    const text = await callTool("domain_error");
    expect(text).toContain('Level "epic" cannot be a child of "feature".');
    expect(text).not.toMatch(/reference [0-9a-f]{8}/);
  });
});

describe("requireUuid", () => {
  it("rejects an abbreviated id before it reaches Postgres", () => {
    // The exact mistake that surfaced the leak: the first octet of a spec id
    // looks like it ought to be enough.
    expect(() => requireUuid({ specId: "7f053ebc" }, "specId")).toThrow(
      /must be a full UUID/,
    );
  });

  it("says which argument was wrong and what to do about it", () => {
    try {
      requireUuid({ specId: "7f053ebc" }, "specId");
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('"specId"');
      expect(message).toContain("list_items");
      // A DomainError, or the boundary would replace this useful text with a
      // reference id and the agent would never learn to send the whole id.
      expect(err).toBeInstanceOf(McpToolError);
    }
  });

  it("accepts a canonical uuid in either case, trimmed", () => {
    expect(requireUuid({ id: `  ${WORKSPACE_ID}  ` }, "id")).toBe(WORKSPACE_ID);
    expect(requireUuid({ id: WORKSPACE_ID.toUpperCase() }, "id")).toBe(
      WORKSPACE_ID.toUpperCase(),
    );
  });

  it("rejects near-misses that would otherwise reach the database", () => {
    for (const bad of [
      `${WORKSPACE_ID}x`,
      WORKSPACE_ID.replace(/-/g, ""),
      `{${WORKSPACE_ID}}`,
      `urn:uuid:${WORKSPACE_ID}`,
      "gggggggg-ffff-4bcd-8e2a-633c96807359",
    ]) {
      expect(() => requireUuid({ id: bad }, "id")).toThrow(McpToolError);
    }
  });

  it("still rejects a missing or empty argument", () => {
    expect(() => requireUuid({}, "specId")).toThrow(/required/);
    expect(() => requireUuid({ specId: "   " }, "specId")).toThrow(/required/);
  });
});
