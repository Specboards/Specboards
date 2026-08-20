import { NextResponse, type NextRequest } from "next/server";

import { needsOriginCheck, originAllowed } from "@/lib/csrf-origin";

/** The GitHub App "Setup URL" route, where GitHub lands admins post-install. */
const GITHUB_SETUP_PATH = "/api/v1/github/setup";

/**
 * Old -> new host redirects for the Specboard -> Specboards domain move. The Fly
 * apps still serve the old certs, so both domains reach this app; we 301 human
 * navigation to the new canonical host. Scoped to browser page loads
 * (non-API GET/HEAD) on purpose: API and webhook POSTs on the old domain must
 * keep working un-redirected until the GitHub App and API clients are pointed at
 * the new host (a 301 would drop the POST body / break webhook signatures).
 */
const HOST_REDIRECTS: Record<string, string> = {
  "app.specboard.ai": "app.specboards.ai",
  "test.specboard.ai": "test.specboards.ai",
};

/**
 * Build the per-request Content-Security-Policy. `script-src` carries a
 * per-request nonce plus `strict-dynamic` and NO `'unsafe-inline'`, so only
 * Next's own nonce-tagged bootstrap (and the chunks it loads) can execute:
 * an injected inline `<script>` is refused by the browser.
 *
 * `style-src` (which governs `<style>` elements and `<link>` stylesheets) also
 * drops `'unsafe-inline'`: our stylesheets are bundled and served from 'self',
 * Next nonce-tags any `<style>` it injects, sonner's runtime injection is
 * patched out in favour of a static CSS import (see layout.tsx), and Radix's
 * scroll-lock `<style>` (react-remove-scroll → react-style-singleton) is
 * nonce-tagged by seeding webpack's runtime nonce (see components/webpack-nonce
 * mounted in layout.tsx). So an injected `<style>` block is refused unless it
 * carries the nonce. `style-src-attr` keeps `'unsafe-inline'` for the inline
 * `style="..."` attributes React and Radix legitimately set (dynamic widths,
 * tree indentation): those are element-scoped CSSOM mutations, not a
 * script-injection or CSS-exfiltration vector.
 *
 * `next dev` is the one exception. React Refresh evaluates its runtime with
 * `eval`, which this policy refuses, and the refusal is not a warning: the
 * bootstrap chunk dies with it and *nothing* on the page hydrates, so every
 * client component silently stops responding to clicks. Development therefore
 * adds `'unsafe-eval'` (and the HMR websocket to `connect-src`). Both are keyed
 * off `NODE_ENV`, which Next fixes to "production" in a built app, so neither
 * can reach a deployment; `e2e/security-headers.spec.ts` runs against a
 * production build and asserts the shipped policy has neither.
 */
const DEV = process.env.NODE_ENV !== "production";

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      DEV ? " 'unsafe-eval'" : ""
    }`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com",
    "font-src 'self' data:",
    `connect-src 'self'${DEV ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** A fresh base64 nonce for the CSP (edge-runtime safe: Web Crypto + btoa). */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Middleware. Three jobs:
 *
 * 1. Normalize a stray trailing space in the GitHub App's hand-configured
 *    "Setup URL". A space there makes GitHub redirect to
 *    `/api/v1/github/setup%20?installation_id=…`, a path segment that doesn't
 *    match the real route, so the admin hits a 404 mid-install. We catch any
 *    trailing-whitespace variant and redirect to the canonical route, keeping
 *    the `?installation_id=…&setup_action=…` query intact.
 *
 * 2. Emit a nonce-based Content-Security-Policy. The nonce is generated here,
 *    threaded to the request as `x-nonce` (Next reads the request CSP header to
 *    tag its inline bootstrap, and the layout reads `x-nonce` for next-themes),
 *    and set on the response. This is per-request, so it lives in middleware
 *    rather than the static `next.config` headers.
 *
 * 3. Inject the active org slug (the first path segment) as the `x-org-slug`
 *    request header so server code can resolve the tenant without threading
 *    `params.org` through every page (ADR 0001, D3). Authority still comes from
 *    a validated membership in `requireWorkspaceAccess` - this is only a hint.
 *
 * 4. Refuse a cross-site mutating API request. Here rather than in each route
 *    because it has to hold for all ~70 of them and a per-route check is a list
 *    somebody forgets to add to. See `lib/csrf-origin.ts` for the rule and why
 *    an absent `Origin` is allowed.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Domain move: redirect browser navigation from the old host to the new one,
  // preserving path + query. Only GET/HEAD page loads are redirected; API and
  // webhook traffic on the old host falls through and is served directly.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const newHost = HOST_REDIRECTS[host];
  if (
    newHost &&
    !pathname.startsWith("/api/") &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    const url = req.nextUrl.clone();
    url.hostname = newHost;
    url.port = "";
    return NextResponse.redirect(url, 301);
  }

  // `nextUrl.pathname` may arrive encoded (`…/setup%20`) or decoded (`…/setup `)
  // depending on the hop; decode then trim trailing whitespace to catch both.
  // A malformed percent-escape (`/%C0`) makes decodeURIComponent throw, so guard
  // it: an undecodable path can't be the setup route, so fall through untouched.
  let normalized = pathname;
  try {
    normalized = decodeURIComponent(pathname).replace(/\s+$/, "");
  } catch {
    normalized = pathname;
  }
  if (normalized === GITHUB_SETUP_PATH && pathname !== GITHUB_SETUP_PATH) {
    const url = req.nextUrl.clone();
    url.pathname = GITHUB_SETUP_PATH;
    return NextResponse.redirect(url);
  }

  // Before anything else that costs work: a refused request should not have a
  // nonce minted for it or headers assembled.
  if (needsOriginCheck(req.method, pathname)) {
    const expected = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim() ?? null;
    const requestHost =
      req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? null;
    if (!originAllowed(req.headers.get("origin"), expected, requestHost)) {
      return NextResponse.json(
        {
          error:
            "This request came from another site. If you are using the API, " +
            "send an API key and no Origin header.",
        },
        { status: 403 },
      );
    }
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  // Next reads the request-side CSP to nonce-tag its own inline scripts.
  headers.set("content-security-policy", csp);
  // API routes resolve their own scope; only pages need the org-slug hint.
  if (!pathname.startsWith("/api/")) {
    headers.set("x-org-slug", pathname.split("/")[1] ?? "");
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  // Run on app routes plus the GitHub setup family (so the trailing-space guard
  // above can fire); skip Next internals and static assets. API routes other
  // than the guard fall through to `NextResponse.next()` above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
