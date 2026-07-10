import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubAppSlug, getGithubOauthCredentials } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  INSTALL_STATE_MAX_AGE,
  createInstallState,
  installUrlWithState,
} from "@/lib/github-install";
import { orgPath } from "@/lib/org-path";
import { getMembership, workspaceSlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/install-start — begin the GitHub App install. We record a
 * pending flow server-side (nonce + user + workspace, see
 * `github_install_states`), drop the nonce in a short-lived cookie, and bounce
 * the admin to GitHub's install page with the nonce as `state`. GitHub echoes
 * `state` back to the setup callback, which checks it against both the cookie
 * and the server-side record; the bind itself only happens after the OAuth
 * identity leg proves the admin owns the installation's GitHub account.
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

  // Fail closed up front: without OAuth client credentials the callback could
  // never verify account ownership, so don't send anyone to GitHub at all.
  if (!(await getGithubOauthCredentials(db))) {
    console.error(
      "[github] install-start refused: no OAuth client credentials " +
        "(set GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET or re-run App setup).",
    );
    return redirectTo(repos("?error=install-config"));
  }

  const appSlug = await getGithubAppSlug(db);
  const state = await createInstallState(db, {
    workspaceId: membership.workspaceId,
    userId: user.id,
  });
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
