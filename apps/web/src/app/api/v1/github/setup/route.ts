import { cookies } from "next/headers";

import { githubInstallations, sql } from "@specboard/db";
import { getInstallationAccount } from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubApp } from "@/lib/github-app";
import { INSTALL_STATE_COOKIE } from "@/lib/github-install";
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
 * after they install (or reconfigure) the App. We bind that installation to the
 * admin's workspace in `github_installations`, so the connect picker and repo
 * creation keep working on later visits (no short-lived session to re-run).
 *
 * The id is validated against GitHub before it's stored: only installations of
 * THIS deployment's App resolve, so a made-up id never persists. Note the
 * residual trust gap: a hostile workspace admin who starts the flow could
 * substitute another real installation id of the shared App before returning
 * here. Binding it would let them list that installation's repo names and sync
 * contents. Closing this needs proof the caller controls the GitHub account
 * (e.g. GitHub OAuth identity), tracked for the pen-test follow-up.
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
  // require the `state` GitHub echoed back to match the one-time cookie. This
  // stops an attacker from luring an admin to a setup URL that binds a foreign
  // installation to their session. The cookie is single-use.
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  jar.delete(INSTALL_STATE_COOKIE);
  if (
    membership.role !== "admin" ||
    !installationId ||
    !state ||
    !expectedState ||
    state !== expectedState
  ) {
    return redirectTo(repos("?error=install"));
  }

  const app = await getGithubApp(db);
  if (!app) return redirectTo(repos("?error=install"));

  // Look the installation up on GitHub: validates the id belongs to this App
  // and captures the account (org/user) for display and repo creation.
  let account;
  try {
    account = await getInstallationAccount(app, installationId);
  } catch (err) {
    console.error(`[github] setup callback couldn't resolve installation ${installationId}:`, err);
    return redirectTo(repos("?error=install"));
  }

  await db
    .insert(githubInstallations)
    .values({
      workspaceId: membership.workspaceId,
      installationId,
      accountLogin: account.login,
      accountType: account.type,
    })
    .onConflictDoUpdate({
      target: [githubInstallations.workspaceId, githubInstallations.installationId],
      set: {
        accountLogin: account.login,
        accountType: account.type,
        updatedAt: sql`now()`,
      },
    });

  return redirectTo(repos("?connected=1"));
}
