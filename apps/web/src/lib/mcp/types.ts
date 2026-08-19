import { type RequiredScope, type ScopeResource } from "@/lib/api-scopes";
import { getDb } from "@/lib/db";
import { DomainError } from "@/lib/errors";
import { type WorkspaceScope } from "@/lib/store";
import { isUuid } from "@/lib/uuid";
import { type MemberRole } from "@/lib/workspace";

/**
 * The shape every MCP tool module shares. Split out of `tools.ts` so a tool
 * module (e.g. `doc-tools.ts`) can define tools without importing the array
 * that collects them, which would be a cycle.
 */

/** Per-call tenant context, resolved once per request from the API key. */
export interface McpContext {
  /** Tenant scope passed to the store; `undefined` in local file mode. */
  scope: WorkspaceScope | undefined;
  /** The caller's workspace role, or null in local file mode. */
  role: MemberRole | null;
  /** True when auth is disabled (self-host local file mode): everything allowed. */
  isLocal: boolean;
  /**
   * Scopes granted to the API key behind this call. `[]` means unrestricted: a
   * browser session, an OAuth token, a legacy full-access key, or local mode.
   * The RPC layer checks these against each tool's own {@link McpTool.scope};
   * tools never read this themselves.
   */
  scopes: string[];
  /**
   * Rate-limit identity for the *credential*, not the user: two OAuth clients
   * belonging to one person get separate keys, so a runaway agent cannot
   * exhaust its owner's other connections. `null` in local file mode, which has
   * no database to count in. Read by the RPC layer only; tools ignore it.
   */
  credentialKey: string | null;
  /**
   * Whether this credential may call tools flagged {@link McpTool.destructive}.
   *
   * Only an OAuth connection can have this withheld, because only its consent
   * screen asks the question. An API key is governed by its scopes alone, and
   * local file mode by nothing, so both are `true`: this narrows the OAuth path
   * and changes nothing elsewhere.
   */
  allowDestructive: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (advertised via tools/list). */
  inputSchema: Record<string, unknown>;
  /** Marks a mutating tool. Any member may attempt it; per-product write
   * (owner, or an admin/contributor grant) is enforced by the store on run. */
  write: boolean;
  /**
   * Marks a tool whose ordinary path commits to a git repository, which costs a
   * GitHub round trip and a commit rather than a row update. These are counted
   * against the much tighter `mcpWrite` quota, per call, so a 50-call batch
   * cannot smuggle 50 commits past the per-request counter.
   *
   * A few of these commit only for some arguments (`delete_item` only with
   * `removeSpec`, the doc tools only for a GitHub-backed area). They are still
   * flagged: over-counting a cheap call against a generous budget is the safe
   * direction, and the alternative is a quota that depends on arguments.
   */
  commits?: boolean;
  /**
   * Marks a tool that destroys data rather than changing it, so an OAuth
   * connection can be granted authorship without also being granted deletion.
   *
   * This has to be its own flag because no `<resource>:<action>` scope
   * separates these: `delete_item` and `update_item` both require
   * `features:write`. A consent screen that could only offer resource scopes
   * would have to choose between "cannot edit anything" and "can delete
   * everything", which is why the destructive set is called out by name.
   */
  destructive?: boolean;
  /**
   * The API-key scope this tool requires, the same `<resource>:<action>`
   * vocabulary the REST routes derive from their URL. Required, not optional:
   * `/api/mcp` is a single URL, so nothing else can supply it, and a tool added
   * without one would otherwise be reachable by any key. `resource` must be a
   * known {@link ScopeResource}, and `action` must be `write` whenever `write`
   * is true (asserted in `tools.test.ts`).
   */
  scope: RequiredScope & { resource: ScopeResource };
  run: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

/**
 * An error a tool raises on purpose, whose message is written for the model.
 *
 * A {@link DomainError}, so the RPC layer surfaces its text rather than
 * replacing it with a reference id. Tools must use this (or another
 * `DomainError`) for anything the agent is meant to read and act on: a bare
 * `Error` is now treated as an internal fault and its message is withheld.
 */
export class McpToolError extends DomainError {}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpToolError(
      `"${key}" is required and must be a non-empty string.`,
    );
  }
  return value;
}

/**
 * A required argument that is bound to a `uuid` column, checked here rather
 * than left to Postgres.
 *
 * Postgres rejects a malformed uuid with a type error, which is correct but
 * arrives as a driver error carrying the whole statement, and the RPC layer now
 * (rightly) refuses to repeat those to the caller. So an agent that abbreviates
 * an id - a real thing agents do, since these ids are long and the first octet
 * looks like enough - would get "something went wrong" for what is really a
 * typo. Checking first turns that into an answer it can act on.
 *
 * Deliberately strict about the canonical form: accepting a prefix or a
 * braced/urn spelling would mean guessing which row was meant.
 */
export function requireUuid(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = requireString(args, key);
  const trimmed = value.trim();
  if (!isUuid(trimmed)) {
    throw new McpToolError(
      `"${key}" must be a full UUID (8-4-4-4-12 hex), not "${trimmed}". ` +
        `These ids are not abbreviated; copy the whole value from list_items.`,
    );
  }
  return trimmed;
}

/**
 * An optional string argument. Absent, null, and empty all read as "not given",
 * so an agent that fills a field it does not care about with `""` gets the
 * documented default rather than a validation error.
 */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new McpToolError(`"${key}" must be a string when given.`);
  }
  return value.trim() === "" ? null : value;
}

/**
 * An optional row cap for a list tool: absent means "no cap", any given value
 * must be a positive integer within `max`.
 *
 * List tools that return a whole workspace are the surface an agent meets first
 * on a board it did not set up, and the one most likely to blow its context
 * before it has learned anything. Rejecting a bad limit loudly beats silently
 * ignoring it, which would look to the caller like the cap did not work.
 */
export function optionalLimit(value: unknown, max: number): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new McpToolError(
      `"limit" must be a whole number between 1 and ${max}.`,
    );
  }
  return n;
}

/**
 * Git-backed tools need a real workspace + database (they commit to GitHub).
 * Resolve both, or fail with a clear message in local file mode.
 */
export function requireDbScope(ctx: McpContext): {
  db: NonNullable<ReturnType<typeof getDb>>;
  scope: WorkspaceScope;
} {
  const db = getDb();
  if (!db || !ctx.scope) {
    throw new McpToolError(
      "Editing spec content needs a database-backed deployment with a " +
        "connected GitHub repository; it is unavailable in local file mode.",
    );
  }
  return { db, scope: ctx.scope };
}
