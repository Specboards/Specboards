import { cookies } from "next/headers";

import { getBrowserSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  APP_SETUP_COOKIE,
  appOriginFromRequest,
  newSetupNonce,
  secureCookies,
} from "@/lib/github-install";
import { renderManifestForm } from "@/lib/github-manifest-form";
import { orgPath } from "@/lib/org-path";
import { isPubliclyReachable } from "@/lib/public-origin";
import { isMultiTenant } from "@/lib/tenancy";
import { getMembership, workspaceSlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** GitHub org/user logins are alphanumeric with single hyphens. */
function isValidOwner(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(value);
}

function htmlRedirect(path: string): Response {
  return new Response(null, { status: 302, headers: { Location: path } });
}

/**
 * GET /api/v1/github/app/create — start the GitHub App "manifest" flow. Admins
 * land here from the Repositories setup UI. We render a tiny auto-submitting
 * form that POSTs an App definition (name, permissions, webhook + callback URLs)
 * to GitHub; the admin confirms once and GitHub creates the App, then redirects
 * back to our callback with a short-lived code we exchange for credentials.
 *
 * `?org=` targets an organization's App settings; omit it for a personal
 * account. A CSRF nonce is stashed in a cookie and echoed as `state`.
 */
export async function GET(req: Request) {
  const db = getDb();
  const user = await getBrowserSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/app/create${new URL(req.url).search}`);
    return htmlRedirect(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership) return htmlRedirect("/");
  const slug = await workspaceSlug(db, membership.workspaceId);
  const repos = (q = "") => orgPath(slug, `/settings/repositories${q}`);
  if (membership.role !== "owner") {
    return htmlRedirect(repos("?error=forbidden"));
  }

  // On the hosted (multi-tenant) deployment, GitHub is a single shared App that
  // Specboards owns and configures via env — tenants install it, never create
  // one. Creating here would both hit GitHub's reserved-name wall ("Specboards"
  // is reserved for @specboards) and overwrite the deployment-wide singleton
  // credentials. The manifest flow is self-host only.
  if (isMultiTenant()) {
    return htmlRedirect(repos("?error=hosted"));
  }

  const org = new URL(req.url).searchParams.get("org")?.trim() ?? "";
  if (org && !isValidOwner(org)) {
    return htmlRedirect(repos("?error=org"));
  }

  const origin = appOriginFromRequest(req);
  const nonce = newSetupNonce();

  // Stop here rather than sending the operator to a GitHub error page they
  // cannot act on. GitHub validates the manifest's webhook URL for public
  // reachability and refuses the whole App when it fails, and it does so
  // whether `active` is true or false; omitting `hook_attributes` is refused
  // too ("Hook url cannot be blank"). So a manifest from an instance GitHub
  // cannot reach can never succeed, and the only useful thing to do is say so
  // in our own UI, on this side of the redirect. Such a deployment uses the
  // manual credential path (`app/manual`) instead.
  if (!isPubliclyReachable(origin)) {
    return htmlRedirect(repos("?error=origin_not_public"));
  }

  // GitHub App names are globally unique and GitHub reserves the bare name
  // "Specboards" for the @specboards account, so every self-host App must carry a
  // distinguishing suffix. Prefer the admin-supplied org name, falling back to
  // this workspace's slug.
  const manifest = {
    name: `Specboards (${org || slug})`,
    url: origin,
    hook_attributes: { url: `${origin}/api/webhooks/github`, active: true },
    redirect_url: `${origin}/api/v1/github/app/callback`,
    // Where GitHub may send the user-identity OAuth leg; the setup callback
    // bounces through it to prove the installer owns the installation account.
    callback_urls: [`${origin}/api/v1/github/oauth/callback`],
    setup_url: `${origin}/api/v1/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      // administration lets the App create the dedicated spec repo during
      // onboarding; it is repo-scoped Administration, not org administration.
      administration: "write",
      contents: "write",
      pull_requests: "write",
      issues: "read",
      metadata: "read",
      // Organization Members (read) lets the install-bind flow verify, via the
      // installer's own user token, that they administer the org an installation
      // belongs to (GET /user/memberships/orgs/{org}). Without it that lookup
      // 403s and every org installation fails to complete. Read-only; the App
      // never manages membership.
      members: "read",
    },
    default_events: ["push", "pull_request", "issues"],
  };

  const action = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  const html = renderManifestForm({ action, nonce, manifest, org });

  const jar = await cookies();
  jar.set(APP_SETUP_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(req),
    path: "/",
    maxAge: 60 * 10,
  });

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
