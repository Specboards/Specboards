import { and, eq, githubUserTokens, type Database } from "@specboards/db";
import {
  canPushToRepo,
  getGithubUserLogin,
  refreshGithubUserToken,
  type GithubUserToken,
} from "@specboards/git";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getGithubOauthCredentials } from "@/lib/github-app";

/**
 * Storing and using a person's GitHub token.
 *
 * These are the first credentials this product holds that can write to someone
 * else's repository, so the rules are deliberately narrow:
 *
 * - **Encrypted at rest**, both tokens, with the same helper that protects the
 *   App private key. A database disclosure alone must not yield a usable token.
 * - **Never returned to a caller in plaintext.** Everything here hands back a
 *   client or a boolean; the token itself does not leave this module, so it
 *   cannot end up in a log line, an API response, or an error message.
 * - **Fail to the App, never to an error.** Every failure mode (expired,
 *   revoked, refresh refused, no push access) falls back to the installation
 *   token with a co-author trailer. An author must never lose a save because
 *   attribution could not be arranged.
 */

/** How close to expiry a token is refreshed rather than used. */
const REFRESH_MARGIN_MS = 60_000;

/** What a caller learns about a stored connection, minus the secret. */
interface GithubConnection {
  githubLogin: string;
  connectedAt: string;
}

/**
 * Save (or replace) the acting user's connection. Called only from the OAuth
 * callback, which is the one place a raw token legitimately exists.
 */
export async function storeGithubUserToken(
  db: Database,
  workspaceId: string,
  userId: string,
  githubLogin: string,
  token: GithubUserToken,
): Promise<void> {
  const values = {
    workspaceId,
    userId,
    githubLogin,
    accessToken: encryptSecret(token.accessToken),
    refreshToken: token.refreshToken ? encryptSecret(token.refreshToken) : null,
    accessTokenExpiresAt: token.accessTokenExpiresAt,
    refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    updatedAt: new Date(),
  };
  await db
    .insert(githubUserTokens)
    .values(values)
    // Reconnecting replaces rather than stacks, including when it is a
    // different GitHub account: the newest consent is the operative one.
    .onConflictDoUpdate({
      target: [githubUserTokens.workspaceId, githubUserTokens.userId],
      set: values,
    });
}

/** Whose account is connected, for the UI. Never exposes the token. */
export async function getGithubConnection(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<GithubConnection | null> {
  const [row] = await db
    .select({
      githubLogin: githubUserTokens.githubLogin,
      createdAt: githubUserTokens.createdAt,
    })
    .from(githubUserTokens)
    .where(
      and(
        eq(githubUserTokens.workspaceId, workspaceId),
        eq(githubUserTokens.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    githubLogin: row.githubLogin,
    connectedAt: row.createdAt.toISOString(),
  };
}

/**
 * Forget a connection.
 *
 * Deletes our copy; it does not revoke the grant on GitHub's side, which only
 * the user can do from their own settings. Said plainly wherever this is
 * surfaced, because "disconnected" implying revocation would be a false
 * assurance about someone's account security.
 */
export async function deleteGithubUserToken(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(githubUserTokens)
    .where(
      and(
        eq(githubUserTokens.workspaceId, workspaceId),
        eq(githubUserTokens.userId, userId),
      ),
    );
}

/**
 * A usable access token for this user, refreshing it first if needed, or null.
 *
 * Private to this module: callers get {@link resolveUserWriteToken}'s verdict,
 * never the string.
 */
async function usableToken(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(githubUserTokens)
    .where(
      and(
        eq(githubUserTokens.workspaceId, workspaceId),
        eq(githubUserTokens.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const expiresAt = row.accessTokenExpiresAt?.getTime();
  const stale =
    expiresAt !== undefined && expiresAt - REFRESH_MARGIN_MS <= Date.now();
  if (!stale) return decryptSecret(row.accessToken);

  // Expired with nothing to refresh from is a dead connection. Leave the row:
  // deleting it here would silently unconnect someone as a side effect of a
  // save, and the settings page is where that should be visible and deliberate.
  if (!row.refreshToken) return null;

  const creds = await getGithubOauthCredentials(db);
  if (!creds) return null;
  try {
    const fresh = await refreshGithubUserToken(
      creds,
      decryptSecret(row.refreshToken),
    );
    await db
      .update(githubUserTokens)
      .set({
        accessToken: encryptSecret(fresh.accessToken),
        refreshToken: fresh.refreshToken
          ? encryptSecret(fresh.refreshToken)
          : row.refreshToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
        refreshTokenExpiresAt: fresh.refreshTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(githubUserTokens.id, row.id));
    return fresh.accessToken;
  } catch (err) {
    // A refused refresh means the user revoked the grant, or GitHub expired it
    // beyond recovery. Neither is an error the author should be shown.
    console.warn("[github-user-token] refresh refused:", err);
    return null;
  }
}

/**
 * Decide whether this write can be made as the author, and hand back the token
 * to make it with.
 *
 * Push access is checked up front rather than discovered at commit time: a
 * save that dies halfway with a 403 leaves the author reading about
 * permissions they have never heard of, when the honest outcome is to commit
 * as the App and name them as co-author instead.
 */
export async function resolveUserWriteToken(
  db: Database,
  workspaceId: string,
  userId: string | null | undefined,
  repo: { owner: string; name: string },
): Promise<string | null> {
  if (!userId) return null;
  try {
    const token = await usableToken(db, workspaceId, userId);
    if (!token) return null;
    if (!(await canPushToRepo(token, repo.owner, repo.name))) return null;
    return token;
  } catch (err) {
    // Attribution is never worth failing a save over.
    console.warn("[github-user-token] could not resolve a user token:", err);
    return null;
  }
}

/** The login behind a freshly issued token, for storing alongside it. */
export async function loginForToken(token: string): Promise<string> {
  return getGithubUserLogin(token);
}
