import { NextResponse, type NextRequest } from "next/server";

/** The GitHub App "Setup URL" route, where GitHub lands admins post-install. */
const GITHUB_SETUP_PATH = "/api/v1/github/setup";

/**
 * Middleware. Two jobs:
 *
 * 1. Normalize a stray trailing space in the GitHub App's hand-configured
 *    "Setup URL". A space there makes GitHub redirect to
 *    `/api/v1/github/setup%20?installation_id=…`, a path segment that doesn't
 *    match the real route, so the admin hits a 404 mid-install. We catch any
 *    trailing-whitespace variant and redirect to the canonical route, keeping
 *    the `?installation_id=…&setup_action=…` query intact. The self-host
 *    manifest flow sets this URL programmatically, so only the manually
 *    configured hosted App can drift; this is the safety net for it.
 *
 * 2. Inject the active org slug (the first path segment) as the `x-org-slug`
 *    request header so server code can resolve the tenant without threading
 *    `params.org` through every page (ADR 0001, D3). Authority still comes from
 *    a validated membership in `requireWorkspaceAccess` — this header is only a
 *    hint. API routes resolve their own scope, so they're left untouched.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // `nextUrl.pathname` may arrive encoded (`…/setup%20`) or decoded (`…/setup `)
  // depending on the hop; decode then trim trailing whitespace to catch both.
  const normalized = decodeURIComponent(pathname).replace(/\s+$/, "");
  if (normalized === GITHUB_SETUP_PATH && pathname !== GITHUB_SETUP_PATH) {
    const url = req.nextUrl.clone();
    url.pathname = GITHUB_SETUP_PATH;
    return NextResponse.redirect(url);
  }

  // API routes resolve their own scope; don't inject the org-slug hint for them.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const slug = pathname.split("/")[1] ?? "";
  const headers = new Headers(req.headers);
  headers.set("x-org-slug", slug);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Run on app routes plus the GitHub setup family (so the trailing-space guard
  // above can fire); skip Next internals and static assets. API routes other
  // than the guard fall through to `NextResponse.next()` above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
