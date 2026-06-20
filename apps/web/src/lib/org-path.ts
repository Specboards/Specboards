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

/**
 * Canonical permalink for a backlog item: the type segment is the item's level
 * key, then its specId (ADR 0002). e.g. `/acme/web/backlog/work/{specId}` or
 * `/acme/web/backlog/epic/{id}`. The bare `/backlog/{specId}` shape still
 * resolves (it redirects here), so callers without a level can fall back to it.
 */
export function itemPath(
  org: string,
  product: string,
  item: { level: string; specId: string },
): string {
  return orgProductPath(org, product, `/backlog/${item.level}/${item.specId}`);
}

// Org-slug helpers (slugifyOrg / RESERVED_ORG_SLUGS / isReservedOrgSlug /
// ORG_SLUG_MAX) live in @specboard/core so they're unit-tested and shareable;
// re-exported here since callers already import slug concerns from org-path.
export {
  ORG_SLUG_MAX,
  RESERVED_ORG_SLUGS,
  isReservedOrgSlug,
  slugifyOrg,
} from "@specboard/core";

/** Slug used for the single, local org in auth-disabled file mode. */
export const LOCAL_ORG_SLUG = "local";

/**
 * Reserved second path segments that are org-scoped (not products), so a bare
 * `/{org}/{seg}/…` is never read as a product. Next routes these to their
 * literal segments (which take priority over `[product]`); the client product
 * hook uses the same set to know when there's no product in context.
 */
export const ORG_SCOPED_SEGMENTS = new Set(["settings", "repositories"]);
