import { getAuth } from "@/lib/auth";
import { resolveReadAccess } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getMembership } from "@/lib/workspace";

import { TOOLS, type McpContext } from "./tools";

/**
 * A minimal, stateless MCP server over the Streamable HTTP transport, spoken as
 * JSON-RPC 2.0 (single messages or batches) with plain `application/json`
 * responses. We implement only what a tools-only server needs - initialize,
 * tools/list, tools/call, ping - which keeps the surface small and dependency
 * free. Auth is the same `sb_` API key the REST API uses, resolved per request.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER_INFO = { name: "specboard", version: "0.1.0" } as const;
const INSTRUCTIONS =
  "Specboard exposes your product backlog: initiatives, epics, and " +
  "git-backed feature specs, grouped into products. Call whoami first to " +
  "learn your role and the hierarchy levels. Use list_items / read_item to " +
  "review work, update_item to change metadata or a DB-native card's body, " +
  "and create_item to add higher-level cards. Edit an actual spec's Markdown " +
  "with update_spec_content (commits to git), and break a card down by " +
  "creating child specs with create_spec, then update_item(parentSpecId) to " +
  "nest each under the card. To roll changes up, read the child specs and " +
  "write a summary into the parent card with update_item(details).";

export type McpAuth =
  | { ok: true; ctx: McpContext }
  | { ok: false; unauthenticated: boolean; message: string };

const NO_WORKSPACE_MESSAGE = "You do not belong to a workspace.";

/**
 * Resolve the caller from the request's credentials. Two paths: an `sb_` API
 * key (or browser session cookie) via the REST auth path, or an OAuth access
 * token minted by the Better Auth mcp plugin's token endpoint. Either way the
 * caller acts as the resolved user, inheriting their workspace membership and
 * role. `unauthenticated: true` means no valid credential at all, which the
 * route turns into a 401 + WWW-Authenticate challenge so OAuth-capable MCP
 * clients start the sign-in flow.
 */
export async function resolveMcpAuth(req: Request): Promise<McpAuth> {
  const access = await resolveReadAccess(req);
  if (access.ok) {
    if (!access.access) {
      // Local file mode (auth disabled): everything allowed with no scope.
      return { ok: true, ctx: { scope: undefined, role: null, isLocal: true } };
    }
    return {
      ok: true,
      ctx: {
        scope: {
          userId: access.access.userId,
          workspaceId: access.access.workspaceId,
        },
        role: access.access.role,
        isLocal: false,
      },
    };
  }

  // Authenticated (key or cookie) but no workspace membership.
  if (access.response.status === 403) {
    return { ok: false, unauthenticated: false, message: NO_WORKSPACE_MESSAGE };
  }

  // No sb_ key or session: check for an OAuth access token.
  const oauth = await resolveOAuthUser(req);
  if (oauth) {
    const db = getDb();
    const membership = db ? await getMembership(db, oauth.userId) : null;
    if (!membership) {
      return { ok: false, unauthenticated: false, message: NO_WORKSPACE_MESSAGE };
    }
    return {
      ok: true,
      ctx: {
        scope: { userId: oauth.userId, workspaceId: membership.workspaceId },
        role: membership.role,
        isLocal: false,
      },
    };
  }

  return {
    ok: false,
    unauthenticated: true,
    message:
      "Authentication required. Connect via OAuth (your MCP client will " +
      "prompt you to sign in) or provide a Specboard API key as a bearer " +
      "token (Authorization: Bearer sb_...).",
  };
}

/**
 * Validate a bearer value as an MCP OAuth access token: an unexpired row in
 * oauth_access_tokens. Returns the token's user, or `null` when the header is
 * absent, not an OAuth token, or expired (getMcpSession checks expiry).
 */
async function resolveOAuthUser(req: Request): Promise<{ userId: string } | null> {
  const auth = getAuth();
  if (!auth) return null;
  const bearer = req.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ")) return null;
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session?.userId) return null;
  return { userId: session.userId };
}

/**
 * Coarse write gate: any workspace member may attempt a write tool. Write
 * authorization is now **per product** (owner, or an admin/contributor grant),
 * enforced by the store on each mutation - so a member writing to a product
 * they can't edit is rejected there with a specific message. This just blocks a
 * caller with no workspace at all.
 */
function canWriteCtx(ctx: McpContext): boolean {
  return ctx.isLocal || ctx.role !== null;
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** An MCP tool result carrying an execution error (surfaced to the model). */
function toolError(text: string) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function initializeResult(params: unknown) {
  const requested = (params as { protocolVersion?: unknown })?.protocolVersion;
  const version =
    typeof requested === "string" &&
    (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function handleToolCall(
  id: JsonRpcId,
  params: unknown,
  auth: McpAuth,
): Promise<JsonRpcResponse> {
  const name = (params as { name?: unknown })?.name;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return ok(id, toolError(`Unknown tool: ${String(name)}`));
  }
  if (!auth.ok) {
    return ok(id, toolError(auth.message));
  }
  if (tool.write && !canWriteCtx(auth.ctx)) {
    return ok(
      id,
      toolError("You must belong to a workspace to make changes."),
    );
  }
  const rawArgs = (params as { arguments?: unknown })?.arguments;
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  try {
    const out = await tool.run(args, auth.ctx);
    return ok(id, {
      content: [
        {
          type: "text",
          text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
        },
      ],
    });
  } catch (err) {
    return ok(id, toolError((err as Error).message));
  }
}

/**
 * Handle one JSON-RPC message. Returns the response, or `null` for
 * notifications (no id) which take no reply.
 */
export async function handleMcpMessage(
  msg: unknown,
  auth: McpAuth,
): Promise<JsonRpcResponse | null> {
  if (
    !msg ||
    typeof msg !== "object" ||
    (msg as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    typeof (msg as { method?: unknown }).method !== "string"
  ) {
    const maybeId = (msg as { id?: JsonRpcId } | null)?.id;
    if (maybeId !== undefined && maybeId !== null) {
      return rpcError(maybeId, -32600, "Invalid Request");
    }
    return null;
  }

  const m = msg as { id?: JsonRpcId; method: string; params?: unknown };
  const isNotification = m.id === undefined || m.id === null;
  const id: JsonRpcId = isNotification ? null : m.id!;

  switch (m.method) {
    case "initialize":
      return ok(id, initializeResult(m.params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call":
      if (isNotification) return null;
      return handleToolCall(id, m.params, auth);
    default:
      // Notifications (e.g. notifications/initialized) take no reply.
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}
