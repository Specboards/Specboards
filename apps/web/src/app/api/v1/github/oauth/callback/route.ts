import { cookies } from "next/headers";

import { and, eq, githubInstallations, ne, sql } from "@specboard/db";
import { exchangeGithubUserCode, verifyInstallationOwnership } from "@specboard/git";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubOauthCredentials } from "@/lib/github-app";
import {
  INSTALL_STATE_COOKIE,
  appOriginFromRequest,
  deleteInstallState,
  findLiveInstallState,
} from "@/lib/github-install";
import { orgPath } from "@/lib/org-path";
import { getMembership, workspaceSlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/oauth/callback — the GitHub App's OAuth "Callback URL",
 * reached from the authorize redirect the setup callback issued. This is where
 * an installation actually gets bound to a workspace.
 *
 * The `code` is exchanged for a user access token, which tells us who the
 * admin is on GitHub; the bind goes through only when that identity owns (for
 * a User account) or actively administers (for an Organization) the account
 * the stashed installation belongs to. Possession of `state` is never treated
 * as proof of GitHub account ownership: it only locates the single-use flow
 * record, which is burned here on every outcome.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/oauth/callback${url.search}`);
    return redirectTo(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership) return redirectTo("/");
  const slug = await workspaceSlug(db, membership.workspaceId);
  const repos = (q = "") => orgPath(slug, `/settings/repositories${q}`);

  // Same double check as the setup callback: browser cookie + server record.
  const jar = await cookies();
  const expectedState = jar.get(INSTALL_STATE_COOKIE)?.value;
  jar.delete(INSTALL_STATE_COOKIE);
  if (
    membership.role !== "owner" ||
    !code ||
    !state ||
    !expectedState ||
    state !== expectedState
  ) {
    return redirectTo(repos("?error=install"));
  }

  const flow = await findLiveInstallState(db, state, user.id);
  if (!flow) return redirectTo(repos("?error=install"));
  // The flow is single-use from here on, whatever the outcome.
  await deleteInstallState(db, flow.id);

  if (
    flow.workspaceId !== membership.workspaceId ||
    !flow.installationId ||
    !flow.accountLogin ||
    !flow.accountType
  ) {
    return redirectTo(repos("?error=install"));
  }

  const oauth = await getGithubOauthCredentials(db);
  if (!oauth) return redirectTo(repos("?error=install-config"));

  // Who is this admin on GitHub, and do they own the installation's account?
  let verdict;
  try {
    const origin = appOriginFromRequest(req);
    const token = await exchangeGithubUserCode(
      oauth,
      code,
      `${origin}/api/v1/github/oauth/callback`,
    );
    verdict = await verifyInstallationOwnership(token, {
      login: flow.accountLogin,
      type: flow.accountType,
    });
  } catch (err) {
    console.error("[github] install identity verification errored:", err);
    return redirectTo(repos("?error=install"));
  }

  if (!verdict.ok) {
    console.warn(
      `[security] refused to bind installation ${flow.installationId} ` +
        `(account ${flow.accountLogin}) to workspace ${flow.workspaceId}: ` +
        `GitHub user ${verdict.viewerLogin} is not an owner/admin (${verdict.reason}).`,
    );
    return redirectTo(repos("?error=install-denied"));
  }

  // One installation serving several workspaces can be legitimate (the same
  // GitHub org backing two Specboard orgs), but it is also what a takeover
  // would look like, so make it loud. Authorization is the check above, not
  // this signal.
  const elsewhere = await db
    .select({ workspaceId: githubInstallations.workspaceId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, flow.installationId),
        ne(githubInstallations.workspaceId, flow.workspaceId),
      ),
    );
  if (elsewhere.length > 0) {
    console.warn(
      `[security] installation ${flow.installationId} (account ${flow.accountLogin}) ` +
        `is now bound to ${elsewhere.length + 1} workspaces; latest bind by GitHub user ` +
        `${verdict.viewerLogin} for workspace ${flow.workspaceId}.`,
    );
  }

  await db
    .insert(githubInstallations)
    .values({
      workspaceId: flow.workspaceId,
      installationId: flow.installationId,
      accountLogin: flow.accountLogin,
      accountType: flow.accountType,
    })
    .onConflictDoUpdate({
      target: [githubInstallations.workspaceId, githubInstallations.installationId],
      set: {
        accountLogin: flow.accountLogin,
        accountType: flow.accountType,
        updatedAt: sql`now()`,
      },
    });

  return redirectTo(repos("?connected=1"));
}
