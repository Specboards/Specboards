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
 */

export type ScopeAction = "read" | "write";

export interface RequiredScope {
  resource: string;
  action: ScopeAction;
}

/** One valid scope token: `*`, or `<resource>:<read|write>`. */
const SCOPE_RE = /^([a-z][a-z0-9-]*):(read|write)$/;

/** A human-readable list of the resources scopes can target (for docs/UI). */
export const SCOPE_RESOURCES = [
  "features",
  "products",
  "repositories",
  "releases",
  "cycles",
  "views",
  "ideas",
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

/**
 * Validate an untrusted scopes list (from key creation). Each entry must be
 * `"*"` or `"<resource>:<read|write>"`. Returns a de-duplicated, sorted copy.
 * Throws {@link InvalidScopeError} on any malformed entry. An empty/omitted
 * list is allowed and denotes a full-access key.
 */
export class InvalidScopeError extends Error {}

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
