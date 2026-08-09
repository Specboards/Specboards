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
