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
 * Slugs an org may never take.
 *
 * A slug now has to be safe in two dimensions, and both are enforced by this
 * one set rather than two, deliberately: a slug is simultaneously a path
 * segment and (with the public portal) a hostname, so satisfying one dimension
 * and forgetting the other is exactly the mistake to make impossible. Anything
 * added here is a name no customer can have, so each entry earns its place.
 *
 * ── As a path segment ──────────────────────────────────────────────────────
 * A real top-level route (or framework internal) would shadow `/{slug}/…` and
 * leave the org unreachable.
 *
 * ── As a subdomain ─────────────────────────────────────────────────────────
 * The portal is served at `{slug}.specboards.ai`, so a slug is a hostname on a
 * wildcard-covered zone. This dimension is more dangerous than the path one:
 * a workspace slugged `app` would claim `app.specboards.ai`, which is the
 * production application, and one slugged `mail` could interfere with the
 * hostnames deliverability depends on. A path collision makes one org
 * unreachable; a hostname collision hands a customer a name the deployment
 * itself is using.
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  // ── Real routes ──────────────────────────────────────────────────────────
  "api",
  "setup",
  "sign-in",
  "sign-up",
  "forgot-password",
  "reset-password",
  // Reached from a link in an email, by somebody who may never have signed in.
  // A workspace on this slug would shadow it and leave that person with no way
  // to stop the mail.
  "unsubscribe",
  "_next",
  "favicon.ico",
  "local",

  // ── Hosts this deployment already serves ─────────────────────────────────
  // Each of these resolves to something real today, so a collision is not a
  // clash of names but a customer being handed one of our services.
  "app", // app.specboards.ai, production
  "test", // test.specboards.ai, staging
  "www", // the marketing site
  "admin", // the internal admin portal
  "portal", // this feature's own name; a "Portal" workspace would be ambiguous

  // ── Mail ─────────────────────────────────────────────────────────────────
  // Transactional mail is how sign-up codes, invitations and notifications
  // arrive, and its reputation is deployment-wide rather than per tenant. These
  // are the hostnames mail infrastructure and mail clients look for; serving a
  // customer's portal from one is a deliverability problem nobody would connect
  // back to a workspace name.
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "mx",
  "bounces",
  "autodiscover", // probed automatically by Outlook and friends
  "autoconfig", // and by Thunderbird

  // ── DNS and certificates ─────────────────────────────────────────────────
  "ns",
  "ns1",
  "ns2",
  "localhost",

  // ── Conventional operational hosts ───────────────────────────────────────
  // Not in use today. Reserved because they are the names anybody would reach
  // for when adding one, and taking a hostname back from a customer who has
  // published a portal on it is not a thing we can do politely.
  "assets",
  "cdn",
  "static",
  "docs",
  "status",
  "staging",
  "dev",
  "demo",
  "blog",
  "help",
  "support",
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
