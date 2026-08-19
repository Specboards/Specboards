import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type McpTool } from "./types";

/**
 * What an agent is told when a tool call runs out of time.
 *
 * The hole this covers: the timeout was a `Promise.race`, which settles the
 * caller and does nothing to the work. A timed-out write is still running and
 * may still commit, but the agent was told the tool "timed out", which reads as
 * failure. An agent that believes a write failed retries it, immediately, and
 * that is how one commit becomes two.
 *
 * The distinction being asserted is between "this did not happen" and "I do not
 * know whether this happened". Only the second is honest about a write.
 *
 * `./tools` is mocked so the surface can be driven without a database: the real
 * registry needs a store the moment anything runs.
 */

/** Never settles, so the timeout always wins the race. */
function hangingTool(over: Partial<McpTool>): McpTool {
  return {
    name: "hang",
    description: "Hangs forever, for testing the timeout.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    scope: { resource: "features", action: "read" },
    run: () => new Promise<never>(() => {}),
    ...over,
  } as McpTool;
}

const TOOLS: McpTool[] = [
  hangingTool({ name: "hang_read", write: false }),
  hangingTool({
    name: "hang_write",
    write: true,
    scope: { resource: "features", action: "write" },
  }),
];

vi.mock("./tools", () => ({ TOOLS }));

// Imported after the mock so the module graph picks it up.
const { handleMcpMessage } = await import("./rpc");

function auth() {
  return {
    ok: true as const,
    ctx: {
      scope: { userId: "user-1", workspaceId: "ws-1" },
      role: "owner" as const,
      isLocal: false,
      // Unrestricted, so the scope gate never fires and the timeout is the only
      // thing under test.
      scopes: [],
      // No credential key, so the quota check stays out of the way.
      credentialKey: null,
      allowDestructive: true,
    },
  };
}

/**
 * Drive one tool call to completion with time advanced past the tool timeout.
 * The call is started, the clock is run forward, then the promise is awaited.
 */
async function callWithTimeoutElapsed(tool: string): Promise<string> {
  const pending = handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    },
    auth(),
  );
  await vi.advanceTimersByTimeAsync(31_000);
  const res = await pending;
  const result = res?.result as { content?: { text: string }[] } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("tool call timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tells a write caller the outcome is unknown, not that it failed", async () => {
    const text = await callWithTimeoutElapsed("hang_write");
    expect(text).toContain("UNKNOWN");
    // The actionable half: an agent that reads this must not simply retry.
    expect(text).toMatch(/do not retry blindly/i);
    expect(text).toMatch(/read the affected item back/i);
    // And it must not be described in a way that reads as "nothing happened".
    expect(text).not.toMatch(/nothing was changed/i);
  });

  it("tells a read caller that retrying is safe", async () => {
    const text = await callWithTimeoutElapsed("hang_read");
    // A read mutates nothing, so the honest answer is the simple one and the
    // agent should not be warned off retrying.
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/retrying is safe/i);
    expect(text).not.toContain("UNKNOWN");
  });

  it("still reports the tool and the budget it exceeded", async () => {
    const text = await callWithTimeoutElapsed("hang_write");
    expect(text).toContain("hang_write");
    expect(text).toContain("30000ms");
  });

  it("does not leave the losing promise as an unhandled rejection", async () => {
    // The work outlives the race. If it later rejects, that rejection belongs to
    // nobody and would surface as an unrelated crash, so `withTimeout` swallows
    // it. Asserted by failing the test if the process sees one.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const pending = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hang_write", arguments: {} },
      },
      { ...auth(), ctx: { ...auth().ctx } },
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    await vi.advanceTimersByTimeAsync(1_000);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
