import { randomBytes } from "node:crypto";

import { and, eq, githubInstallStates, lt, sql, type Database } from "@specboard/db";

/**
 * GitHub App installation flow helpers.
 *
 * The connect experience mirrors Vercel: the admin clicks "Connect
 * GitHub", installs the App (picking repos) on github.com, and GitHub redirects
 * back to our setup callback with an `installation_id`. We never ask anyone to
 * copy ids by hand.
 *
 * Because the callback only carries the `installation_id` (which is guessable),
 * binding is gated on proof of ownership: the flow state lives server-side in
 * `github_install_states` (nonce + session user + workspace), the setup
 * callback verifies the id against GitHub and stashes it there, and a GitHub
 * OAuth identity leg must then prove the signed-in user administers the
 * installation's account before anything lands in `github_installations`. The
 * repo-listing and connect endpoints trust that table, never a client-supplied
 * id, so one workspace's admin can't probe another installation's repositories.
 */

/** A pending install flow row, as read back by the callbacks. */
export interface InstallStateRow {
  id: string;
  nonce: string;
  workspaceId: string;
  userId: string;
  installationId: string | null;
  accountLogin: string | null;
  accountType: string | null;
}

/**
 * Start a server-side install flow for `userId` in `workspaceId`: mints the
 * nonce GitHub will echo back as `state` and records who may complete the
 * flow. Expired rows are swept opportunistically so the table stays small.
 */
export async function createInstallState(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<string> {
  await db
    .delete(githubInstallStates)
    .where(lt(githubInstallStates.expiresAt, sql`now()`));
  const nonce = newSetupNonce();
  await db.insert(githubInstallStates).values({
    nonce,
    workspaceId: input.workspaceId,
    userId: input.userId,
    expiresAt: new Date(Date.now() + INSTALL_STATE_MAX_AGE * 1000),
  });
  return nonce;
}

/**
 * The live (unexpired) flow row for `nonce`, only if it belongs to `userId`,
 * or null. Ownership and expiry checks live here so callers can't forget them.
 */
export async function findLiveInstallState(
  db: Database,
  nonce: string,
  userId: string,
): Promise<InstallStateRow | null> {
  const rows = await db
    .select({
      id: githubInstallStates.id,
      nonce: githubInstallStates.nonce,
      workspaceId: githubInstallStates.workspaceId,
      userId: githubInstallStates.userId,
      installationId: githubInstallStates.installationId,
      accountLogin: githubInstallStates.accountLogin,
      accountType: githubInstallStates.accountType,
    })
    .from(githubInstallStates)
    .where(
      and(
        eq(githubInstallStates.nonce, nonce),
        eq(githubInstallStates.userId, userId),
        sql`${githubInstallStates.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Record the installation GitHub returned, pending the ownership check. */
export async function stashInstallationOnState(
  db: Database,
  stateId: string,
  input: { installationId: string; accountLogin: string; accountType: string },
): Promise<void> {
  await db
    .update(githubInstallStates)
    .set(input)
    .where(eq(githubInstallStates.id, stateId));
}

/** Burn a flow row (success or failure): each nonce is single-use. */
export async function deleteInstallState(db: Database, stateId: string): Promise<void> {
  await db.delete(githubInstallStates).where(eq(githubInstallStates.id, stateId));
}

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

