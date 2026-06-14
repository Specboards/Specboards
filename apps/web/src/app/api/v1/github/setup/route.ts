import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  INSTALL_COOKIE,
  INSTALL_COOKIE_MAX_AGE,
  makeInstallCookieValue,
} from "@/lib/github-install";
import { getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Redirect to a same-origin path. Uses a relative `Location` (resolved by the
 * browser against the public URL it requested) so it works behind Fly's proxy,
 * where `req.url` carries the internal bind address rather than the public host.
 */
function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/setup — the GitHub App's post-install "Setup URL". GitHub
 * redirects the admin's browser here with `?installation_id=…&setup_action=…`
 * after they install (or reconfigure) the App. We bind that installation to the
 * signed-in admin via a short-lived cookie, then bounce to the Repositories
 * page where they pick which granted repo to connect.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const installationId = url.searchParams.get("installation_id");

  const db = getDb();
  const user = await getSessionUser(req);
  // Not signed in (or auth disabled): send them to sign in, then back here.
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/setup${url.search}`);
    return redirectTo(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "admin" || !installationId) {
    return redirectTo("/repositories?error=install");
  }

  // Remember the installation for this admin so the picker can list its repos
  // without trusting a client-supplied (guessable) id.
  const jar = await cookies();
  jar.set(INSTALL_COOKIE, makeInstallCookieValue(user.id, installationId), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: INSTALL_COOKIE_MAX_AGE,
  });

  return redirectTo("/repositories?connected=1");
}
