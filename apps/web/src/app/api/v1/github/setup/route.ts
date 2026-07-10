import { cookies } from "next/headers";

import { getInstallationAccount } from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubApp, getGithubOauthCredentials } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  appOriginFromRequest,
  deleteInstallState,
  findLiveInstallState,
  stashInstallationOnState,
} from "@/lib/github-install";
import { orgPath } from "@/lib/org-path";
import { getMembership, workspaceSlug } from "@/lib/workspace";

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
 * after they install (or reconfigure) the App.
 *
 * This route no longer binds anything. The CSRF `state` only proves a browser
 * finished an install flow, not that the signed-in user controls the GitHub
 * account that owns the returned `installation_id` (a hostile workspace owner
 * could substitute another real installation's id). So we validate the flow
 * (cookie nonce + the server-side `github_install_states` record for this
 * user), verify the id resolves under OUR App, stash it on the flow record,
 * and send the admin through GitHub's OAuth identity leg. The bind happens in
 * /api/v1/github/oauth/callback only after that leg proves the admin owns or
 * administers the installation's account.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  const db = getDb();
  const user = await getSessionUser(req);
  // Not signed in (or auth disabled): send them to sign in, then back here.
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/setup${url.search}`);
    return redirectTo(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership) return redirectTo("/");
  const slug = await workspaceSlug(db, membership.workspaceId);
  const repos = (q = "") => orgPath(slug, `/settings/repositories${q}`);
  const jar = await cookies();

  // CSRF: the install must have started via /install-start on this session, so
  // require the `state` GitHub echoed back to match the one-time cookie. The
  // cookie survives until the OAuth callback finishes the (single-use) flow.
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  if (
    membership.role !== "owner" ||
    !installationId ||
    !state ||
    !expectedState ||
    state !== expectedState
  ) {
    jar.delete(INSTALL_STATE_COOKIE);
    return redirectTo(repos("?error=install"));
  }

  // The server-side flow record is the source of truth: it must exist, be
  // unexpired, belong to this user, and match the workspace they're acting in.
  const flow = await findLiveInstallState(db, state, user.id);
  if (!flow || flow.workspaceId !== membership.workspaceId) {
    jar.delete(INSTALL_STATE_COOKIE);
    return redirectTo(repos("?error=install"));
  }

  const app = await getGithubApp(db);
  const oauth = await getGithubOauthCredentials(db);
  if (!app || !oauth) {
    jar.delete(INSTALL_STATE_COOKIE);
    await deleteInstallState(db, flow.id);
    return redirectTo(repos("?error=install-config"));
  }

  // Look the installation up on GitHub: validates the id belongs to this App
  // and captures the account (org/user) the ownership check must match.
  let account;
  try {
    account = await getInstallationAccount(app, installationId);
  } catch (err) {
    console.error(`[github] setup callback couldn't resolve installation ${installationId}:`, err);
    jar.delete(INSTALL_STATE_COOKIE);
    await deleteInstallState(db, flow.id);
    return redirectTo(repos("?error=install"));
  }

  await stashInstallationOnState(db, flow.id, {
    installationId,
    accountLogin: account.login,
    accountType: account.type,
  });

  // OAuth identity leg: GitHub sends the admin back to our callback with a
  // `code` we exchange to learn who they are on GitHub. Same nonce as `state`.
  const origin = appOriginFromRequest(req);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", oauth.clientId);
  authorize.searchParams.set("redirect_uri", `${origin}/api/v1/github/oauth/callback`);
  authorize.searchParams.set("state", state);
  return redirectTo(authorize.toString());
}
