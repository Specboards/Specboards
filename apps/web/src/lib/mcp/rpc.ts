import { randomUUID } from "node:crypto";

import { keyScopesSatisfy } from "@/lib/api-scopes";
import { getAuth } from "@/lib/auth";
import { orgSlugFromRequest, resolveReadAccess } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isDomainError } from "@/lib/errors";
import { checkQuota, QUOTAS } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/security-log";
import { resolveApiMembership } from "@/lib/workspace";

import { TOOLS } from "./tools";
import { type McpContext, type McpTool } from "./types";
import {
  boundConnection,
  oauthClientName,
  retireUngrantedConnection,
  touchMcpConnection,
} from "./workspace-binding";

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
  "or a DB-native card's body. Where list_statuses reports transitionMode " +
  "\"strict\", stages must be walked in order: pass update_item(advance: true) " +
  "to move an item several stages in one call rather than issuing one call per " +
  "stage. transitionMode is configured per product, so pass list_statuses a " +
  "productId when you are working in one product, or read it off read_item's " +
  "allowedTransitions, which is always resolved for that item's own product. " +
  "Use create_item to add a card at ANY level, including the leaf: a " +
  "spec is an optional attachment to a work item, not a requirement for one, " +
  "so work being done by a person rather than an agent is tracked as an " +
  "ordinary item and rolls up the same way. Edit an actual spec's Markdown " +
  "with update_spec_content (commits to git), and break a card down by " +
  "creating child specs with create_spec, then update_item(parentSpecId) to " +
  "nest each under the card. Pass create_spec a workItemId to ATTACH a spec " +
  "to an item that already exists, which keeps its id, status and history " +
  "instead of creating a second card for the same work. To roll changes up, " +
  "read the child specs and " +
  "write a summary into the parent card with update_item(details). After you " +
  "open a PR for an item, record it with link_github (kind pull_request / " +
  "issue / branch); list_github_links shows an item's links and unlink_github " +
  "removes one. Remove an item with delete_item; one that has a spec attached " +
  "needs removeSpec: true, which deletes its spec file from git too (without " +
  "that it would be re-imported on the next sync). " +
  "Organize work into versions with list_releases " +
  "and create_release; revise a release's dates, status, name, notes, or " +
  "product with update_release. A release belongs to a product (managed by that " +
  "product's admins/contributors) or is a workspace-wide portfolio release (set " +
  "productId to null; owner-only). Schedule an item into a release via " +
  "update_item(releaseId); the item must belong to the release's product, or " +
  "the release must be a portfolio release. Cycles (sprints / iterations) are " +
  "a SECOND, ORTHOGONAL axis: a release is what ships together, a cycle is " +
  "the time box a team works in, and an item can be in both at once. Use " +
  "list_cycles / create_cycle / update_cycle, schedule with " +
  "update_item(cycleId), and rollover_cycle to move a closing cycle's " +
  "unfinished work into the next one (finished work stays put). A cycle has " +
  "no status: it is upcoming, active or complete purely from its dates. " +
  "Goals (objectives) say WHY work exists, in a form that can be measured: " +
  "list_goals / read_goal / create_goal / update_goal / delete_goal, " +
  "create_key_result, update_key_result and delete_key_result for the " +
  "measurements, and link_goal to record that an " +
  "item ladders up to a goal. read_goal adds what list_goals omits: the work " +
  "items linked to the goal. read_item reports the same edge from the item's " +
  "side, as its `goals`. Goals are deliberately NOT a hierarchy level - " +
  "they are measured, and the work serving them is many-to-many across " +
  "products - so link_goal works from any level and an item can serve several " +
  "goals. Each goal reports two separate progress figures: `progress` (the " +
  "mean of its key results, i.e. did the outcome move) and " +
  "`deliveryProgress` (the share of linked work done, i.e. did we ship it). " +
  "Never average them: shipping everything while no metric moves is precisely " +
  "what goals exist to reveal. " +
  "Alongside the work items and the goals sits the narrative plan: each " +
  "product's Strategy (why it exists and the current targets), Research " +
  "(discovery, interviews, synthesis) and Architecture (engineering " +
  "constitution, service boundaries, contracts) areas. Manage them with " +
  "list_docs / read_doc / create_doc / update_doc / delete_doc, which take a " +
  "product key plus the area. One set of tools covers every backing an area " +
  "can have: pages Specboards holds, or Markdown files in a connected GitHub " +
  "repo (where the page's docId IS the file path and every edit is a commit); " +
  "an area that merely links out to an external repository is read-only here " +
  "and list_docs returns its link. Read the Architecture area before " +
  "designing, and the Strategy area before arguing about priority. " +
  "Products can be collected into " +
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
      // Local file mode (auth disabled): everything allowed with no scope, and
      // no database to count a quota in.
      return {
        ok: true,
        ctx: {
          scope: undefined,
          role: null,
          isLocal: true,
          scopes: [],
          credentialKey: null,
          allowDestructive: true,
        },
      };
    }
    return {
      ok: true,
      ctx: {
        scope: {
          userId: access.access.userId,
          workspaceId: access.access.workspaceId,
          // An `sb_` key resolves to `api_key` and a session cookie to `user`,
          // which is right either way: the key path is an automation acting for
          // its owner, the cookie path is that person's own browser session.
          actor: access.access.actor,
        },
        role: access.access.role,
        isLocal: false,
        // Carried through so each tool call can be checked against the key's
        // grants; `/api/mcp` has no path-derived scope to check instead.
        scopes: access.credential.scopes,
        // `key:` matches the REST side's `apiRequest` scope id, deliberately:
        // one key's budget should be the same budget whichever surface it hits.
        credentialKey: access.credential.viaKey
          ? `key:${access.access.userId}`
          : `session:${access.access.userId}`,
        // A key's scopes are its whole gate: there is no consent screen on this
        // path to have asked anything narrower.
        allowDestructive: true,
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
    const binding = db
      ? await boundConnection(db, oauth.userId, oauth.clientId)
      : null;
    // No recorded grant, no call. A binding whose `scopes` is NULL predates the
    // consent screen asking; a missing binding means consent never recorded one
    // at all (the authorize flow completed but the grant POST did not). Both
    // used to resolve to "unrestricted, destructive allowed", which made the
    // absence of an answer the most permissive answer available.
    //
    // The connection is retired rather than quietly downgraded. A downgrade
    // would leave an agent running with less authority than it had and no way to
    // discover why, which surfaces as tools failing one at a time; a 401 makes
    // an OAuth-capable client restart the flow, and the user re-answers the
    // question that was never put to them.
    // The refusal does not depend on `db`: being unable to reach the database is
    // a reason to refuse, never a reason to fall through to the permissive path.
    // Only the retire is conditional, and a failed retire is survivable because
    // the next call refuses again.
    if (!binding || binding.scopes == null) {
      logSecurityEvent("mcp-connection-ungranted", {
        clientId: oauth.clientId,
        reason: binding ? "legacy-null-scopes" : "no-binding",
      });
      if (db) {
        await retireUngrantedConnection(db, oauth.userId, oauth.clientId).catch(
          () => {},
        );
      }
      return {
        ok: false,
        unauthenticated: true,
        message:
          "This connection was authorized before Specboards asked what an " +
          "agent may do, so it has been disconnected. Reconnect and choose " +
          "what to allow: your MCP client will prompt you to sign in again.",
      };
    }

    const orgSlug = orgSlugFromRequest(req) ?? binding.slug;
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
    // Best-effort: a failed bump must not fail the call it was recording.
    if (db) {
      await touchMcpConnection(db, oauth.userId, oauth.clientId).catch(() => {});
    }

    return {
      ok: true,
      ctx: {
        scope: {
          userId: oauth.userId,
          workspaceId: resolved.membership.workspaceId,
          // An OAuth connection is always a tool, never a person at a keyboard,
          // and it told us its name at registration. Recording that is the
          // difference between "Claude Code (agent)" and "Someone" in the
          // ledger; the user it acted for is still on the row as the actor id.
          actor: {
            type: "agent",
            id: oauth.userId,
            label: db ? await oauthClientName(db, oauth.clientId) : null,
          },
        },
        role: resolved.membership.role,
        isLocal: false,
        // Per connection, not per user: two agents one person authorised get
        // independent budgets, so a runaway one cannot starve the other.
        credentialKey: `oauth:${oauth.clientId}:${oauth.userId}`,
        // What the user granted this client on the consent screen. Always a
        // real list: the ungranted cases returned above, so there is no longer a
        // path where an absent grant is read as an unrestricted one.
        scopes: binding.scopes,
        allowDestructive: binding.allowDestructive,
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

/**
 * Whether the credential behind this call may use `tool`.
 *
 * The REST routes get this from their URL; `/api/mcp` is one URL for ~40 tools,
 * so the check has to happen here or not at all. It used to not happen at all,
 * which let a key scoped `features:read` call every write tool at its owner's
 * full authority.
 *
 * An empty `ctx.scopes` is unrestricted by the same rule the REST side uses:
 * browser sessions, OAuth tokens and legacy pre-scopes keys are not
 * scope-limited.
 */
export function toolAllowedByScope(tool: McpTool, ctx: McpContext): boolean {
  if (tool.destructive && !ctx.allowDestructive) return false;
  if (ctx.scopes.length === 0) return true;
  return keyScopesSatisfy(ctx.scopes, tool.scope);
}

/**
 * Count this request's `calls` against the credential's MCP request quota,
 * returning the retry delay in seconds when it is over budget and `null` when
 * it may proceed.
 *
 * `calls` is the JSON-RPC batch length, not 1. A batch of 50 is 50 units of
 * work, and charging it as one request would let any caller multiply its real
 * quota fiftyfold simply by batching.
 *
 * Unauthenticated requests are not counted: they never reach a tool, and there
 * is no credential to key on. The endpoint is authenticated on every path, so
 * the credential is the right scope (`lib/client-ip.ts` carries the trust model
 * that would be needed to limit by IP, and it only holds for public intake).
 */
export async function checkMcpRequestQuota(
  auth: McpAuth,
  calls: number,
): Promise<number | null> {
  if (!auth.ok || !auth.ctx.credentialKey) return null;
  const result = await checkQuota(
    getDb(),
    QUOTAS.mcpRequest,
    auth.ctx.credentialKey,
    calls,
  );
  return result.ok ? null : result.retryAfter;
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
 *
 * Reviewed when the timeout was made to report writes as indeterminate. It
 * stays at 30s: the expensive call here is a spec commit, which is several
 * GitHub round trips (ref, blob, tree, commit, update ref) and lands in a few
 * seconds normally, so 30s is comfortably clear of the ordinary case while
 * still leaving room under a 60s client budget. Raising it would mostly extend
 * how long a genuinely wedged call ties up a connection; lowering it would
 * start reporting healthy commits as indeterminate, which is the more expensive
 * mistake now that the message asks the agent to go and re-read.
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

/**
 * A short, logged handle for an error whose text the caller is not allowed to
 * see, so a report of "my agent said reference a1b2c3d4" can still be matched
 * to the real failure in the Fly logs.
 *
 * Deliberately not derived from the error in any way: the point is that it
 * carries no information about what went wrong.
 */
function errorRef(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Decide what a failed tool call may tell the caller.
 *
 * Our own {@link DomainError}s are written for whoever made the call ("No item
 * with spec id X.", "status must be a non-empty string.") and the agent needs
 * them verbatim to correct itself. Everything else was written for somebody
 * holding a stack trace and quotes internals freely: drizzle's
 * `DrizzleQueryError` message is the entire failing SQL statement plus every
 * bound parameter, which here meant handing any connected agent the schema and
 * the workspace id in exchange for one malformed argument.
 *
 * So the default is to withhold, and hand back a reference id instead. That is
 * the safe direction for a mistake to fall: a domain error somebody forgets to
 * derive from `DomainError` costs the agent a vaguer message, whereas the old
 * default cost a disclosure.
 */
function toolFailure(
  err: unknown,
  toolName: string,
): { text: string; ref: string | null } {
  if (isDomainError(err)) return { text: err.message, ref: null };
  const ref = errorRef();
  return {
    text:
      `"${toolName}" failed for an internal reason, which has been logged ` +
      `as reference ${ref}. This is not something the arguments can be ` +
      `changed to fix; retrying may work, and quoting that reference lets ` +
      `an administrator find the cause.`,
    ref,
  };
}

/**
 * A tool call that ran out of time.
 *
 * Its own type because the caller has to treat it differently from an ordinary
 * failure: `Promise.race` settles the *caller*, it does not cancel the work, so
 * a timed-out write is still running and may still commit.
 */
class ToolTimeoutError extends Error {
  constructor(
    readonly tool: string,
    readonly ms: number,
  ) {
    super(`Tool "${tool}" timed out after ${ms}ms.`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Reject if `p` has not settled within `ms`; always clears its timer.
 *
 * This bounds how long the *caller* waits and nothing more. The underlying work
 * carries on: there is no cancellation to hand it, because the store and the
 * GitHub client do not take one. That is exactly why the rejection is typed, so
 * the call site can say "unknown" instead of "failed"; see `describeTimeout`.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
    // The loser of the race is still pending. Nothing here can stop it, but an
    // unhandled rejection from it would be logged as if it were unrelated, so
    // it is swallowed: the call site has already been told the outcome is
    // unknown, and a late failure does not change that.
    void Promise.resolve(p).catch(() => {});
  }
}

/**
 * What to tell an agent whose call timed out.
 *
 * The distinction that matters is between "this did not happen" and "I do not
 * know whether this happened", and only the second is true of a write. The old
 * message said the tool failed, which is the one thing we cannot know: the
 * commit or the row update may land a moment after we stop waiting.
 *
 * Getting this wrong is worse for an agent than for a person. A person who sees
 * a timeout reloads and looks; an agent retries, immediately, and the retry is
 * what turns one write into two. The same reasoning already governs the DB
 * retry above, which refuses to replay a write for exactly this reason.
 *
 * A read is safe to report as a plain failure: nothing was mutated, so retrying
 * costs only time.
 */
function describeTimeout(err: ToolTimeoutError, isWrite: boolean): string {
  if (!isWrite) {
    return `${err.message} Nothing was changed; retrying is safe.`;
  }
  return (
    `${err.message} The outcome is UNKNOWN: the write was not cancelled and ` +
    `may still complete. Do not retry blindly. Read the affected item back ` +
    `first, and only repeat the call if the change is genuinely absent.`
  );
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
  if (!toolAllowedByScope(tool, auth.ctx)) {
    // Two different refusals, and the difference is actionable: a missing scope
    // is fixed by minting a better credential, a withheld destructive grant by
    // reconnecting and choosing differently. One message for both would send
    // the agent looking in the wrong place.
    if (tool.destructive && !auth.ctx.allowDestructive) {
      logMcpCall({ tool: tool.name, denied: "destructive" });
      return ok(
        id,
        toolError(
          `"${tool.name}" deletes data, and this connection was not granted ` +
            `that. Ask the person who connected it to reconnect and allow ` +
            `deletion, or make the change without deleting.`,
        ),
      );
    }
    const { resource, action } = tool.scope;
    logMcpCall({ tool: tool.name, denied: "scope", required: `${resource}:${action}` });
    return ok(
      id,
      toolError(
        `This credential lacks the "${resource}:${action}" scope, which ` +
          `"${tool.name}" requires.`,
      ),
    );
  }
  if (tool.write && !canWriteCtx(auth.ctx)) {
    return ok(
      id,
      toolError("You must belong to a workspace to make changes."),
    );
  }
  // Counted per call, after the cheap checks, so a refused or unauthorized call
  // does not spend a commit's worth of budget. A per-request counter cannot do
  // this job: one batch can carry 50 commits.
  if (tool.commits && auth.ctx.credentialKey) {
    const quota = await checkQuota(
      getDb(),
      QUOTAS.mcpWrite,
      auth.ctx.credentialKey,
    );
    if (!quota.ok) {
      logMcpCall({
        tool: tool.name,
        denied: "rate_limit",
        retryAfter: quota.retryAfter,
      });
      return ok(
        id,
        toolError(
          `Rate limit reached for tools that commit to git ` +
            `(${QUOTAS.mcpWrite.limit} per ` +
            `${QUOTAS.mcpWrite.windowSec / 60} minutes). Wait ` +
            `${quota.retryAfter}s and retry; reads are unaffected.`,
        ),
      );
    }
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
    if (err instanceof ToolTimeoutError) {
      // Logged as its own outcome rather than folded into `ok=false`, because
      // "we stopped waiting" and "it failed" are different events and only the
      // first leaves work possibly still running. A run of these on a write
      // tool is the signal that something downstream is wedged.
      logMcpCall({
        tool: tool.name,
        ok: false,
        ms: Date.now() - started,
        timeout: tool.write ? "write_indeterminate" : "read",
      });
      return ok(id, toolError(describeTimeout(err, tool.write)));
    }
    const failure = toolFailure(err, tool.name);
    // The full message is logged either way: withholding it from the caller is
    // the point, withholding it from us would just make the bug unfindable.
    logMcpCall({
      tool: tool.name,
      ok: false,
      ms: Date.now() - started,
      errType: (err as Error)?.name ?? typeof err,
      ...(failure.ref ? { ref: failure.ref } : {}),
      err: (err as Error)?.message ?? String(err),
    });
    return ok(id, toolError(failure.text));
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
      // Advertise only what this credential may actually call, so an agent is
      // not offered a tool it will be refused on. Convenience, not the gate:
      // tools/call re-checks, because a client may call a name it was never
      // offered.
      return ok(id, {
        tools: TOOLS.filter((t) => !auth.ok || toolAllowedByScope(t, auth.ctx)).map(
          (t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }),
        ),
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
