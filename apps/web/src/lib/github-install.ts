import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub App installation flow helpers.
 *
 * The connect experience mirrors Vercel/Supabase: the admin clicks "Connect
 * GitHub", installs the App (picking repos) on github.com, and GitHub redirects
 * back to our setup callback with an `installation_id`. We never ask anyone to
 * copy ids by hand.
 *
 * Because the callback only carries the `installation_id` (which is guessable),
 * the callback issues a short-lived signed cookie binding that installation to
 * the signed-in admin. The "list repos for this installation" endpoint trusts
 * the cookie, not a client-supplied id — so one workspace's admin can't probe
 * another installation's repositories.
 */

/** Cookie holding the signed, pending installation id after the App callback. */
export const INSTALL_COOKIE = "sb_gh_install";

/** How long a pending installation stays connectable before re-installing. */
export const INSTALL_COOKIE_MAX_AGE = 60 * 15; // 15 minutes

/** The App slug, e.g. `specboard-test`, used to build the install URL. */
export function githubAppSlug(): string | null {
  return process.env.NEXT_PUBLIC_GITHUB_APP_SLUG?.trim() || null;
}

/** Where to send a user to install the App, or null if the slug is unset. */
export function githubAppInstallUrl(): string | null {
  const slug = githubAppSlug();
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set.");
  return value;
}

/** HMAC binding an installation id to a specific user. */
function sign(userId: string, installationId: string): string {
  return createHmac("sha256", secret())
    .update(`${userId}.${installationId}`)
    .digest("hex");
}

/** Cookie value for a freshly captured installation. */
export function makeInstallCookieValue(userId: string, installationId: string): string {
  return `${installationId}.${sign(userId, installationId)}`;
}

/**
 * Recover the installation id from the cookie, verifying it was signed for this
 * user. Returns null when missing, malformed, or signed for someone else.
 */
export function readInstallCookie(userId: string, cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const installationId = cookieValue.slice(0, dot);
  const provided = cookieValue.slice(dot + 1);
  const expected = sign(userId, installationId);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return installationId;
}
