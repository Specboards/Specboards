import { type RequiredScope, type ScopeResource } from "@/lib/api-scopes";
import { getDb } from "@/lib/db";
import { type WorkspaceScope } from "@/lib/store";
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

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
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
    throw new Error(`"${key}" must be a string when given.`);
  }
  return value.trim() === "" ? null : value;
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
    throw new Error(
      "Editing spec content needs a database-backed deployment with a " +
        "connected GitHub repository; it is unavailable in local file mode.",
    );
  }
  return { db, scope: ctx.scope };
}
