import { randomBytes } from "node:crypto";

/**
 * GitHub App installation flow helpers.
 *
 * The connect experience mirrors Vercel/Supabase: the admin clicks "Connect
 * GitHub", installs the App (picking repos) on github.com, and GitHub redirects
 * back to our setup callback with an `installation_id`. We never ask anyone to
 * copy ids by hand.
 *
 * Because the callback only carries the `installation_id` (which is guessable),
 * the callback verifies it against GitHub and persists the binding in
 * `github_installations`, keyed to the admin's workspace. The repo-listing and
 * connect endpoints trust that table, never a client-supplied id, so one
 * workspace's admin can't probe another installation's repositories.
 */

/** Cookie holding the CSRF nonce for the App-creation (manifest) round-trip. */
export const APP_SETUP_COOKIE = "sb_gh_app_setup";

/** Cookie holding the CSRF nonce for the App install → setup round-trip. */
export const INSTALL_STATE_COOKIE = "sb_gh_install_state";

/** How long an install-flow CSRF nonce stays valid. */
export const INSTALL_STATE_MAX_AGE = 60 * 15; // 15 minutes

/** A random CSRF nonce, round-tripped as the manifest/install flow's `state`. */
export function newSetupNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Install URL for `slug`, carrying a CSRF `state` GitHub echoes to setup. */
export function installUrlWithState(
  slug: string | null,
  state: string,
): string | null {
  const base = installUrlFromSlug(slug);
  return base ? `${base}?state=${encodeURIComponent(state)}` : null;
}

/**
 * This deployment's public origin (e.g. `https://test.specboard.ai`). Behind
 * Fly's proxy `req.url` is the internal bind address, so derive it from the
 * forwarded headers (the same ones Better Auth trusts), with an `APP_URL`
 * env override for unusual setups. Used to build absolute GitHub callback URLs.
 */
export function appOriginFromRequest(req: Request): string {
  // Prefer an explicitly configured public URL — authoritative and immune to
  // proxy header quirks. BETTER_AUTH_URL is already set wherever auth runs.
  const configured = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return `${proto}://${host}`;
}

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

