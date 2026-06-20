import { NextResponse, type NextRequest } from "next/server";

/**
 * Canonicalize the apex domain to www. The marketing app answers on both
 * `specboard.ai` and `www.specboard.ai` (same Fly app); we 308-redirect apex →
 * www so there's a single canonical host for SEO and sharing.
 */
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host === "specboard.ai") {
    const url = new URL(req.url);
    url.host = "www.specboard.ai";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Skip Next internals and static assets; only real page requests need the
  // host check.
  matcher: ["/((?!_next/static|_next/image|favicon.svg).*)"],
};
