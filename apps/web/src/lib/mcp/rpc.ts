import { getAuth } from "@/lib/auth";
import { orgSlugFromRequest, resolveReadAccess } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { resolveApiMembership } from "@/lib/workspace";

import { TOOLS, type McpContext } from "./tools";
import { boundWorkspaceSlug } from "./workspace-binding";

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
  "Specboards exposes your product backlog: initiatives, epics, and " +
  "git-backed feature specs, grouped into products. Call whoami first to " +
  "learn your role and the hierarchy levels. Use list_items / read_item to " +
  "review work, list_statuses (or read_item's allowedTransitions) to learn " +
  "which stage keys a status change accepts, update_item to change metadata " +
  "or a DB-native card's body, " +
  "and create_item to add higher-level cards. Edit an actual spec's Markdown " +
  "with update_spec_content (commits to git), and break a card down by " +
  "creating child specs with create_spec, then update_item(parentSpecId) to " +
  "nest each under the card. To roll changes up, read the child specs and " +
  "write a summary into the parent card with update_item(details). After you " +
  "open a PR for an item, record it with link_github (kind pull_request / " +
  "issue / branch); list_github_links shows an item's links and unlink_github " +
  "removes one. Remove a " +
  "DB-native card you no longer need with delete_item (spec-backed items are " +
  "deleted in git, not here). Organize work into versions with list_releases " +
  "and create_release; revise a release's dates, status, name, notes, or " +
  "product with update_release. A release belongs to a product (managed by that " +
  "product's admins/contributors) or is a workspace-wide portfolio release (set " +
  "productId to null; owner-only). Schedule an item into a release via " +
  "update_item(releaseId); the item must belong to the release's product, or " +
  "the release must be a portfolio release. Products can be collected into " +
  "product groups " +
  "(nested management roll-ups): list_product_groups shows them, " +
  "list_items(group) scopes to a group's subtree, and group_summary returns " +
  "per-product status and release roll-ups for a group.";

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

  // No sb_ key or session: check for an OAuth access token. The org is resolved
  // in priority order: an explicit `x-org-slug` header the MCP client sets, then
  // the workspace the user picked for this client on the consent screen, then
  // their sole membership when unambiguous. A multi-org caller who supplies none
  // of these is rejected rather than silently pinned to their oldest org.
  const oauth = await resolveOAuthUser(req);
  if (oauth) {
    const db = getDb();
    const orgSlug =
      orgSlugFromRequest(req) ??
      (db ? await boundWorkspaceSlug(db, oauth.userId, oauth.clientId) : null);
    const resolved = db
      ? await resolveApiMembership(db, oauth.userId, orgSlug)
      : null;
    if (!resolved || !resolved.ok) {
      const message =
        resolved && resolved.error.code === "org_ambiguous"
          ? "You belong to more than one organization. Set the x-org-slug header to name one."
          : NO_WORKSPACE_MESSAGE;
      return { ok: false, unauthenticated: false, message };
    }
    return {
      ok: true,
      ctx: {
        scope: { userId: oauth.userId, workspaceId: resolved.membership.workspaceId },
        role: resolved.membership.role,
        isLocal: false,
      },
    };
  }

  return {
    ok: false,
    unauthenticated: true,
    message:
      "Authentication required. Connect via OAuth (your MCP client will " +
      "prompt you to sign in) or provide a Specboards API key as a bearer " +
      "token (Authorization: Bearer sb_...).",
  };
}

/**
 * Validate a bearer value as an MCP OAuth access token: an unexpired row in
 * oauth_access_tokens. Returns the token's user, or `null` when the header is
 * absent, not an OAuth token, or expired (getMcpSession checks expiry).
 */
async function resolveOAuthUser(
  req: Request,
): Promise<{ userId: string; clientId: string } | null> {
  const auth = getAuth();
  if (!auth) return null;
  const bearer = req.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ")) return null;
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session?.userId) return null;
  return { userId: session.userId, clientId: session.clientId };
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

/**
 * Cap how long a single tool call may run. A wedged dependency (a hung GitHub
 * git call in a write tool, a stalled query) otherwise holds the POST open until
 * the *client's* timeout fires, which the agent reports as the server
 * "disconnecting". Returning a JSON-RPC error keeps the connection healthy and
 * tells the model what happened. MCP clients typically allow ~60s; stay under.
 */
const TOOL_TIMEOUT_MS = 30_000;

/**
 * A dropped/reaped DB socket surfaces as one of these on the first query after
 * an idle gap. postgres.js reconnects for the *next* query, so a single retry of
 * a read clears it transparently. Writes are not retried: a mutation may have
 * committed before the socket died, and replaying it could double-apply.
 */
function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const msg = typeof e?.message === "string" ? e.message : "";
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "CONNECTION_CLOSED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_DESTROYED" ||
    code === "CONNECT_TIMEOUT" ||
    /connection.*(closed|reset|ended|terminated|destroyed)/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT/.test(msg)
  );
}

/** Reject if `p` has not settled within `ms`; always clears its timer. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool "${label}" timed out after ${ms}ms.`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One greppable line per tool call so mid-session failures are visible in the
 * Fly logs (they were invisible before, which is why these disconnects were hard
 * to diagnose). Shaped like `logSecurityEvent`: `[mcp:tool] key=value ...`.
 */
function logMcpCall(fields: Record<string, string | number | boolean>): void {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${k}=${String(v).replace(/\s+/g, "_")}`,
  );
  console.info(`[mcp:tool] ${parts.join(" ")}`);
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
  const started = Date.now();
  const attempt = () =>
    withTimeout(tool.run(args, auth.ctx), TOOL_TIMEOUT_MS, tool.name);
  try {
    let out: unknown;
    try {
      out = await attempt();
    } catch (err) {
      // Retry a read once when the DB socket was reaped mid-idle; never a write.
      if (!tool.write && isTransientDbError(err)) {
        logMcpCall({ tool: tool.name, retry: "transient_db" });
        out = await attempt();
      } else {
        throw err;
      }
    }
    logMcpCall({ tool: tool.name, ok: true, ms: Date.now() - started });
    return ok(id, {
      content: [
        {
          type: "text",
          text: typeof out === "string" ? out : JSON.stringify(out, null, 2),
        },
      ],
    });
  } catch (err) {
    logMcpCall({
      tool: tool.name,
      ok: false,
      ms: Date.now() - started,
      err: (err as Error).message,
    });
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
