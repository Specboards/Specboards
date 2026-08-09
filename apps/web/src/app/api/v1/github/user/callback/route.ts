import { cookies } from "next/headers";

import { exchangeGithubUserCodeForToken } from "@specboards/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubOauthCredentials } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  appOriginFromRequest,
  deleteInstallState,
  findLiveInstallState,
} from "@/lib/github-install";
import { loginForToken, storeGithubUserToken } from "@/lib/github-user-token";
import { orgPath } from "@/lib/org-path";
import { logSecurityEvent } from "@/lib/security-log";
import { workspaceSlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/user/callback — finish connecting a user's GitHub account.
 *
 * Exchanges the `code` for a user-to-server token and stores it encrypted
 * against the workspace membership that started the flow. Nothing here trusts
 * the redirect: the state cookie and the server-side flow row must agree, the
 * flow row must belong to the signed-in user, and it is burned on every
 * outcome including failure, so a code cannot be replayed against it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/user/callback${url.search}`);
    return redirectTo(`/sign-in?from=${from}`);
  }

  const jar = await cookies();
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  jar.delete(INSTALL_STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) {
    logSecurityEvent("github-user-connect-state-mismatch", { userId: user.id });
    return redirectTo("/");
  }

  const flow = await findLiveInstallState(db, state, user.id);
  if (!flow) return redirectTo("/");
  // Single-use from here on, whatever the outcome.
  await deleteInstallState(db, flow.id);

  const creds = await getGithubOauthCredentials(db);
  if (!creds) return redirectTo("/");

  const slug = await workspaceSlug(db, flow.workspaceId);
  const settings = orgPath(slug, "/settings/profile");

  try {
    const redirectUri = `${appOriginFromRequest(req)}/api/v1/github/user/callback`;
    const token = await exchangeGithubUserCodeForToken(creds, code, redirectUri);
    // The login is read with the token we just minted, so it names the account
    // that actually granted us access rather than one asserted in a parameter.
    const login = await loginForToken(token.accessToken);
    await storeGithubUserToken(db, flow.workspaceId, user.id, login, token);
    return redirectTo(`${settings}?github=connected`);
  } catch (err) {
    // Never surfaced to the browser: a failed exchange says more about our
    // credentials than about anything the visitor should read.
    console.error("[github/user/callback] connect failed:", err);
    return redirectTo(`${settings}?github=failed`);
  }
}
