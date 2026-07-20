import { NextResponse, type NextRequest } from "next/server";

/** The GitHub App "Setup URL" route, where GitHub lands admins post-install. */
const GITHUB_SETUP_PATH = "/api/v1/github/setup";

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
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://*.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
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
 *    a validated membership in `requireWorkspaceAccess` — this is only a hint.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
