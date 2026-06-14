import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

/** Cookie holding the CSRF nonce for the App-creation (manifest) round-trip. */
export const APP_SETUP_COOKIE = "sb_gh_app_setup";

/** A random CSRF nonce, round-tripped as the manifest flow's `state`. */
export function newSetupNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * This deployment's public origin (e.g. `https://test.specboard.ai`). Behind
 * Fly's proxy `req.url` is the internal bind address, so derive it from the
 * forwarded headers (the same ones Better Auth trusts), with an `APP_URL`
 * env override for unusual setups. Used to build absolute GitHub callback URLs.
 */
export function appOriginFromRequest(req: Request): string {
  const override = process.env.APP_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return `${proto}://${host}`;
}

/** How long a pending installation stays connectable before re-installing. */
export const INSTALL_COOKIE_MAX_AGE = 60 * 15; // 15 minutes

/** The App slug, e.g. `specboard-test`, used to build the install URL. */
export function githubAppSlug(): string | null {
  return process.env.NEXT_PUBLIC_GITHUB_APP_SLUG?.trim() || null;
}

/** Where to send a user to install an App with the given slug, or null. */
export function installUrlFromSlug(slug: string | null): string | null {
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

/** Where to send a user to install the App (env slug), or null if unset. */
export function githubAppInstallUrl(): string | null {
  return installUrlFromSlug(githubAppSlug());
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
