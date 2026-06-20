/**
 * Org (workspace) URL slugs.
 *
 * In multi-tenant mode the org is a URL path prefix (`/{slug}/…`, ADR-0001 D3),
 * so a slug must be unique, URL-safe, and must not collide with a real
 * top-level route. These helpers are pure so the setup form can preview the
 * exact slug the server will mint.
 */

/** Max length of an org slug. */
export const ORG_SLUG_MAX = 48;

/**
 * Top-level path segments that are real routes (or framework internals), so an
 * org slug must never equal one — otherwise `/{slug}/…` would be shadowed by the
 * literal route and the org would be unreachable. `local` is the file-mode org
 * slug, reserved so a hosted org can't collide with it.
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "setup",
  "sign-in",
  "sign-up",
  "forgot-password",
  "reset-password",
  "_next",
  "favicon.ico",
  "local",
]);

/**
 * Derive a URL slug from an org name: lowercase, non-alphanumerics → single
 * hyphens, trimmed, capped. Returns `""` when nothing usable remains (the
 * caller treats that as "pick a different name").
 */
export function slugifyOrg(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX)
    .replace(/-+$/g, "");
}

/** Whether `slug` collides with a reserved top-level segment. */
export function isReservedOrgSlug(slug: string): boolean {
  return RESERVED_ORG_SLUGS.has(slug);
}
