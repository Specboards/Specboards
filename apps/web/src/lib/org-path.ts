/**
 * Build an org-scoped app path: `orgPath("acme", "/board") → "/acme/board"`.
 * Pure and isomorphic (safe in server and client code). The org segment is the
 * URL tenancy prefix from ADR 0001 (D3).
 */
export function orgPath(org: string, path = "/"): string {
  const rest = path.startsWith("/") ? path : `/${path}`;
  // Avoid a trailing slash for the org root ("/acme", not "/acme/").
  return rest === "/" ? `/${org}` : `/${org}${rest}`;
}

/**
 * Build an org+product-scoped path: `orgProductPath("acme","web","/board")`
 * → "/acme/web/board". Used for the product-scoped areas (board / backlog /
 * roadmap), where the product is a URL segment (ADR 0001 D5).
 */
export function orgProductPath(org: string, product: string, path = "/"): string {
  return orgPath(org, `/${product}${path === "/" ? "" : path}`);
}

/** Slug used for the single, local org in auth-disabled file mode. */
export const LOCAL_ORG_SLUG = "local";

/**
 * Reserved second path segments that are org-scoped (not products), so a bare
 * `/{org}/{seg}/…` is never read as a product. Next routes these to their
 * literal segments (which take priority over `[product]`); the client product
 * hook uses the same set to know when there's no product in context.
 */
export const ORG_SCOPED_SEGMENTS = new Set(["settings", "repositories"]);
