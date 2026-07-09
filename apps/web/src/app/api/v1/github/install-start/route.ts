import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubAppSlug } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  INSTALL_STATE_MAX_AGE,
  installUrlWithState,
  newSetupNonce,
} from "@/lib/github-install";
import { orgPath } from "@/lib/org-path";
import { getMembership, workspaceSlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/install-start — begin the GitHub App install. We mint a
 * CSRF nonce, drop it in a short-lived cookie, and bounce the admin to GitHub's
 * install page with the nonce as `state`. GitHub echoes `state` back to the
 * setup callback, which verifies it against the cookie so an attacker can't
 * lure an admin into binding a foreign installation to their session.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return redirectTo(`/sign-in?from=${encodeURIComponent("/")}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership) return redirectTo("/");
  const slug = await workspaceSlug(db, membership.workspaceId);
  const repos = (q = "") => orgPath(slug, `/settings/repositories${q}`);
  if (membership.role !== "owner") return redirectTo(repos("?error=install"));

  const appSlug = await getGithubAppSlug(db);
  const state = newSetupNonce();
  const url = installUrlWithState(appSlug, state);
  if (!url) return redirectTo(repos("?error=install"));

  const jar = await cookies();
  jar.set(INSTALL_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: INSTALL_STATE_MAX_AGE,
  });

  return redirectTo(url);
}
