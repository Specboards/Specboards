import { cookies } from "next/headers";

import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  APP_SETUP_COOKIE,
  appOriginFromRequest,
  newSetupNonce,
} from "@/lib/github-install";
import { getMembership } from "@/lib/workspace";

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
  const user = await getSessionUser(req);
  if (!db || !user) {
    const from = encodeURIComponent(`/api/v1/github/app/create${new URL(req.url).search}`);
    return htmlRedirect(`/sign-in?from=${from}`);
  }

  const membership = await getMembership(db, user.id);
  if (!membership || membership.role !== "admin") {
    return htmlRedirect("/repositories?error=forbidden");
  }

  const org = new URL(req.url).searchParams.get("org")?.trim() ?? "";
  if (org && !isValidOwner(org)) {
    return htmlRedirect("/repositories?error=org");
  }

  const origin = appOriginFromRequest(req);
  const nonce = newSetupNonce();

  const manifest = {
    name: org ? `SpecBoard (${org})` : "SpecBoard",
    url: origin,
    hook_attributes: { url: `${origin}/api/webhooks/github`, active: true },
    redirect_url: `${origin}/api/v1/github/app/callback`,
    setup_url: `${origin}/api/v1/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
    default_events: ["push"],
  };

  const action = org
    ? `https://github.com/organizations/${org}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  // Embed the manifest as a JS literal (JSON is valid JS); escape `<` so a
  // value can't break out of the <script> element.
  const manifestLiteral = JSON.stringify(manifest).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Setting up GitHub…</title></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px;text-align:center;color:#444;">
    <p>Redirecting you to GitHub to create the SpecBoard app…</p>
    <form id="f" method="post" action="${action}?state=${nonce}">
      <input type="hidden" name="manifest" id="m">
      <noscript><button type="submit">Continue to GitHub</button></noscript>
    </form>
    <script>
      document.getElementById('m').value = JSON.stringify(${manifestLiteral});
      document.getElementById('f').submit();
    </script>
  </body>
</html>`;

  const jar = await cookies();
  jar.set(APP_SETUP_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 10,
  });

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
