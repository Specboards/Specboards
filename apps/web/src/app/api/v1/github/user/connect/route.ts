import { cookies } from "next/headers";

import { getBrowserSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubOauthCredentials } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  INSTALL_STATE_MAX_AGE,
  appOriginFromRequest,
  createInstallState,
} from "@/lib/github-install";
import { resolveApiMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/github/user/connect — start connecting the signed-in user's own
 * GitHub account, so their spec commits are authored by them rather than by the
 * App with their name in a trailer.
 *
 * This asks for nothing beyond identity. The token GitHub returns is a
 * user-to-server token for an App the workspace has already installed, so it
 * reaches only those repositories and only with the intersection of the App's
 * permissions and the user's own. Connecting therefore grants Specboards no
 * new reach; it narrows what a given write can do to what that person could do
 * by hand.
 *
 * Same single-use state machinery as the install flow: a nonce recorded
 * server-side against this user, echoed in a cookie, checked on the way back.
 * Possession of the state is never treated as proof of anything on its own.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getBrowserSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent("/api/v1/github/user/connect");
    return Response.redirect(new URL(`/sign-in?from=${from}`, appOriginFromRequest(req)), 302);
  }

  // The stored token is per (workspace, user), so which workspace this is for
  // has to be explicit rather than "their oldest membership": binding a repo
  // write credential to the wrong tenant is not a mistake worth risking.
  const org = new URL(req.url).searchParams.get("org");
  const membership = await resolveApiMembership(db, user.id, org);
  if (!membership.ok) {
    return Response.json({ error: membership.error.code }, { status: 403 });
  }

  const creds = await getGithubOauthCredentials(db);
  if (!creds) {
    return Response.json(
      { error: "GitHub is not configured on this deployment." },
      { status: 501 },
    );
  }

  const nonce = await createInstallState(db, {
    workspaceId: membership.membership.workspaceId,
    userId: user.id,
  });
  const jar = await cookies();
  jar.set(INSTALL_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: INSTALL_STATE_MAX_AGE,
  });

  const redirectUri = `${appOriginFromRequest(req)}/api/v1/github/user/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", creds.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", nonce);
  return Response.redirect(authorize.toString(), 302);
}
