/**
 * A second layer under `SameSite=Lax` for cookie-authenticated writes.
 *
 * ── Why this exists when Lax already blocks the attack ──────────────────────
 * It does block it today. Better Auth 1.6.26 defaults its session cookie to
 * `sameSite: "lax"` (verified in `dist/cookies/index.mjs`, not assumed), and
 * this codebase sets no `defaultCookieAttributes`, no per-cookie override and no
 * `crossSubDomain`. So a cross-site POST carries no session and achieves
 * nothing.
 *
 * The problem is that this is the ONLY thing standing between a cross-site form
 * and roughly seventy mutating `/api/v1` routes, and it is a property of a
 * dependency's default rather than a decision recorded anywhere. It stops being
 * true the moment somebody sets `sameSite: "none"` to embed the app on another
 * subdomain, which is a plausible thing to want and would not obviously read as
 * a security change. A check that does not depend on the cookie policy means
 * that change is survivable.
 *
 * ── The rule, and why "no Origin" is allowed ───────────────────────────────
 * Refuse when `Origin` is present and is not ours. Allow when it is absent.
 *
 * That asymmetry is the whole design and it is not a loophole. Browsers have
 * sent `Origin` on every non-GET request, form submissions included, since
 * around 2020. So a missing `Origin` on a POST means the caller is not a
 * browser: it is our CLI, an MCP client, a CI job or curl, all of which
 * authenticate with an API key rather than a cookie and therefore cannot be
 * ridden cross-site in the first place. Requiring the header would break every
 * one of them to defend against a request shape that does not exist.
 *
 * `Referer` is deliberately NOT used as a fallback. It is stripped by privacy
 * tooling and by `Referrer-Policy`, so treating its absence as suspicious would
 * fail real browsers, and treating its presence as authoritative adds nothing
 * `Origin` does not already say.
 */

/** Methods that can change something, so worth guarding. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths this does NOT apply to, each for its own reason:
 *
 * - `/api/auth/` is Better Auth's own surface, including the OAuth token
 *   endpoint an MCP client calls. It runs its own CSRF handling, and a
 *   browser-based OAuth client legitimately posts here from its own origin.
 * - `/api/webhooks/` is GitHub, which sends no `Origin` and is authenticated by
 *   HMAC signature. Covered by the "absent is allowed" rule anyway; listed so
 *   nobody later "tightens" this into an outage.
 * - `/api/mcp` authenticates with a bearer token or API key, never a cookie, so
 *   there is no ambient authority to ride. A browser-hosted MCP client would
 *   send its own `Origin` and be refused for no benefit.
 * - `/api/access-request` is the public "Request access" intake, posted to by a
 *   browser on the marketing site (`www.specboards.ai`) cross-origin to this
 *   app. It reads no session, so a cross-site POST rides nothing: it can
 *   achieve exactly what the public form achieves, and its per-IP and per-email
 *   quotas are what bound abuse. Who may post is decided by the route's own
 *   CORS allowlist, not here.
 *
 *   This was not a judgement call originally, it was a live outage. The check
 *   refused the form's POST (403, "This request came from another site") while
 *   the preflight `OPTIONS` passed, because `OPTIONS` is not a mutating method.
 *   So the endpoint looked reachable, the route's CORS allowlist looked
 *   authoritative, and the pre-release sign-up funnel was closed: every
 *   prospect who filled the form in was shown a CSRF error.
 *
 *   Exempting the path is deliberate, in preference to widening `originAllowed`
 *   to accept the marketing origin. The host comparison guards ~70 mutating
 *   `/api/v1` routes that DO carry cookie authority; relaxing it for all of
 *   them to admit one public endpoint trades a real defence for a convenience.
 * - `/api/unsubscribe` is RFC 8058 one-click unsubscribe, POSTed by a mail
 *   provider's infrastructure. Its authorization is the signed token in the
 *   URL, never a cookie, so there is nothing here to ride either.
 *
 *   It was already listed as exempt in its own route file's comment ("Not
 *   origin-checked either, and it must not be"), and that was not true: it was
 *   checked, and passed only because those callers send no `Origin`. So the
 *   route worked by relying on the one property nobody controls, and any
 *   provider that started attaching an `Origin` would silently take one-click
 *   unsubscribe with it.
 *
 *   That failure would be expensive and quiet. A refused unsubscribe is what
 *   turns "unsubscribe me" into "mark as spam", which costs the whole
 *   deployment its sending reputation rather than costing us one recipient,
 *   and it would show up as a deliverability decline rather than as an error
 *   anybody could see. Listing the path makes the route's stated contract the
 *   actual one.
 */
const EXEMPT_PREFIXES = [
  "/api/auth/",
  "/api/webhooks/",
  "/api/mcp",
  "/api/access-request",
  "/api/unsubscribe",
];

/** Whether this request should be origin-checked at all. */
export function needsOriginCheck(method: string, pathname: string): boolean {
  if (!MUTATING.has(method.toUpperCase())) return false;
  if (!pathname.startsWith("/api/")) return false;
  return !EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Whether a request's `Origin` is acceptable.
 *
 * `expected` is the deployment's canonical origin when configured. Without one
 * we fall back to the request's own host, which is weaker (a hostile proxy
 * controls it) but is the same trust model the rest of the app already uses
 * when `APP_URL` is unset, and it still refuses an origin that differs from the
 * host the browser thinks it is talking to.
 */
export function originAllowed(
  origin: string | null,
  expected: string | null,
  host: string | null,
): boolean {
  // Not a browser-initiated request. See the note above.
  if (!origin) return true;
  // Some agents send the literal "null" origin (sandboxed iframe, redirected
  // POST). That is never our own origin, and treating the string as a host
  // would compare nonsense, so refuse explicitly.
  if (origin === "null") return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // An unparseable Origin is not one we issued.
    return false;
  }

  if (expected) {
    try {
      return originHost === new URL(expected).host;
    } catch {
      // A malformed APP_URL is a misconfiguration the boot guard reports; fall
      // through to the host comparison rather than failing every write.
    }
  }
  return host != null && originHost === host;
}
