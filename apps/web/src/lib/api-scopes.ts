/**
 * Resource scopes for API keys. A key's stored `scopes` is a list of
 * `"<resource>:<read|write>"` grants (or the wildcard `"*"`). An EMPTY list
 * means a legacy full-user key (created before scopes existed) and keeps
 * unrestricted access, so existing keys never break. Session (cookie) auth is
 * never scope-limited.
 *
 * Enforcement is centralized: instead of every one of the ~70 `/api/v1` routes
 * declaring its scope, {@link requiredScopeFor} derives the required scope from
 * the request method + path (the resource is the first path segment under
 * `/api/v1/`), and the shared authorization helpers in `auth-session.ts` check
 * it. `write` on a resource implies `read` on that resource.
 *
 * Deriving the scope from the URL only works for surfaces whose URL names the
 * resource. `/api/mcp` does not: it is one endpoint carrying a JSON-RPC tool
 * name, so every MCP tool declares its own scope (`McpTool.scope`) and the RPC
 * layer checks it per call. Anything else off the map is denied outright for
 * key-authenticated callers - see {@link isScopeExemptPath}.
 */

export type ScopeAction = "read" | "write";

export interface RequiredScope {
  resource: string;
  action: ScopeAction;
}

/** One valid scope token: `*`, or `<resource>:<read|write>`. */
const SCOPE_RE = /^([a-z][a-z0-9-]*):(read|write)$/;

/**
 * A human-readable list of the resources scopes can target (for docs/UI).
 *
 * Every `/api/v1/<segment>` a key can reach must appear here, or a key can
 * never be granted access to it (`requiredScopeFor` still derives the scope, and
 * no grant satisfies it). `api-scopes.test.ts` walks the route directory and
 * fails when a new resource route lands without an entry.
 */
export const SCOPE_RESOURCES = [
  "features",
  "specs",
  "comments",
  // Its own resource rather than a path under `features`, precisely so that a
  // key granted `features:write` cannot also spend the workspace's inference
  // budget. See the note on the route.
  "assistant",
  // Separate from `assistant` for the same shape of reason `assistant` is
  // separate from `features`: a key that may ask questions must not also be able
  // to rewrite the standing instructions every future question is asked under.
  "assistant-skills",
  "products",
  "repositories",
  "releases",
  "cycles",
  "goals",
  "key-results",
  "views",
  "ideas",
  "idea-settings",
  "idea-statuses",
  "webhooks",
  "docs",
  "doc-spaces",
  "properties",
  "levels",
  "statuses",
  "stage-gates",
  "detail-templates",
  "product-groups",
  "board-preferences",
  "notifications",
  "org",
  "workspace",
  "me",
] as const;

/** One of the resources a scope may target. */
export type ScopeResource = (typeof SCOPE_RESOURCES)[number];

/**
 * Validate an untrusted scopes list (from key creation). Each entry must be
 * `"*"` or `"<resource>:<read|write>"`. Returns a de-duplicated, sorted copy.
 * Throws {@link InvalidScopeError} on any malformed entry. An empty/omitted
 * list is allowed and denotes a full-access key.
 */
export class InvalidScopeError extends Error {}

/**
 * Validate scopes for a credential being CREATED, where an absent list is not
 * an acceptable answer.
 *
 * {@link parseApiScopes} reads omitted/empty as full access, and
 * {@link keyScopesSatisfy} honours that, because keys minted before scopes
 * existed have `[]` and must keep working. That backwards compatibility is
 * fine for reading an existing key and wrong for minting a new one: it makes
 * *saying nothing* the most permissive thing a caller can do, on the endpoint
 * that hands out credentials.
 *
 * So creation goes through here instead. Full access is still reachable, by
 * asking for it: `["*"]`. The difference is that it becomes a decision on the
 * record rather than a default nobody stated.
 */
export function parseGrantedScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    throw new InvalidScopeError(
      'scopes is required. Pass ["*"] for full access, or a list like ' +
        '["features:write", "statuses:read"].',
    );
  }
  const scopes = parseApiScopes(raw);
  if (scopes.length === 0) {
    throw new InvalidScopeError(
      'scopes cannot be empty. Pass ["*"] for full access, or name the ' +
        "resources this credential needs.",
    );
  }
  return scopes;
}

export function parseApiScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InvalidScopeError("scopes must be an array of strings.");
  }
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new InvalidScopeError("Each scope must be a string.");
    }
    const scope = entry.trim();
    if (scope === "*") {
      out.add("*");
      continue;
    }
    if (!SCOPE_RE.test(scope)) {
      throw new InvalidScopeError(
        `Invalid scope "${entry}". Use "*" or "<resource>:read" / "<resource>:write".`,
      );
    }
    out.add(scope);
  }
  return [...out].sort();
}

/**
 * The scope a request requires, derived from its method and path, or `null`
 * when the path is not a scope-guarded `/api/v1` resource route (e.g. the
 * session-only `/api/v1/api-keys`, or a non-`/api/v1` path). Read methods
 * (GET/HEAD) require `<resource>:read`; everything else requires
 * `<resource>:write`.
 */
export function requiredScopeFor(
  method: string,
  pathname: string,
): RequiredScope | null {
  const match = /^\/api\/v1\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  const resource = match[1]!;
  // API keys cannot manage API keys (session-only); leave that gate to the route.
  if (resource === "api-keys") return null;
  const action: ScopeAction =
    method === "GET" || method === "HEAD" ? "read" : "write";
  return { resource, action };
}

/**
 * Paths a scoped API key may reach even though no `<resource>:<action>` scope
 * is derivable from the URL. Everything else off the map is denied, so a new
 * endpoint cannot silently inherit full key access the way `/api/mcp` did.
 *
 * - `/api/mcp` carries the resource in the JSON-RPC tool name rather than the
 *   URL, so it is scoped per tool (`McpTool.scope`) by `lib/mcp/rpc.ts`. Listed
 *   here so the path-level check defers to that one, not so it goes unchecked.
 * - `/api/v1/openapi.json` is the published API description: it names no tenant
 *   data, and its route is unauthenticated, so it never reaches this check
 *   today. Listed so it stays reachable if it ever gains auth, and so the
 *   resource-vocabulary test does not demand a scope for a document that
 *   describes the scopes.
 *
 * Session (cookie) auth never reaches this: it is not scope-limited at all.
 */
const SCOPE_EXEMPT_PATHS = ["/api/mcp", "/api/v1/openapi.json"] as const;

export function isScopeExemptPath(pathname: string): boolean {
  return SCOPE_EXEMPT_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Whether a key's granted scopes satisfy a required scope. An empty `granted`
 * list is a legacy full-access key and satisfies everything. `"*"` satisfies
 * everything. `"<resource>:write"` satisfies both read and write on that
 * resource; `"<resource>:read"` satisfies only read.
 */
export function keyScopesSatisfy(
  granted: readonly string[],
  required: RequiredScope,
): boolean {
  if (granted.length === 0) return true; // legacy full-access key
  if (granted.includes("*")) return true;
  if (granted.includes(`${required.resource}:write`)) return true;
  if (required.action === "read" && granted.includes(`${required.resource}:read`)) {
    return true;
  }
  return false;
}
