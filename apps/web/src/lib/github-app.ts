import { desc, githubApp, type Database } from "@specboards/db";
import { githubAppFrom, githubAppFromEnv } from "@specboards/git";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isE2E } from "@/lib/e2e";

/**
 * Resolves the deployment's GitHub App, preferring credentials created in-app
 * (the manifest flow, stored encrypted in `github_app`) and falling back to the
 * classic env vars (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / …) so existing
 * deployments keep working. This is the single source of truth for "is GitHub
 * configured, and with what credentials".
 */

/** Decrypted credentials for the deployment's App. */
export interface GithubAppCredentials {
  appId: string;
  slug: string;
  clientId: string | null;
  /** OAuth client secret for identifying users; null for pre-existing Apps. */
  clientSecret: string | null;
  privateKey: string;
  webhookSecret: string;
}

/** True for a Postgres "relation does not exist" error (migration not applied). */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "42P01";
}

/**
 * Memoized decrypt of the stored credentials.
 *
 * ── Why this is worth caching ──────────────────────────────────────────────
 * The GitHub webhook endpoint is unauthenticated by construction: it has to
 * read the credentials before it can verify the signature that decides whether
 * the request is genuine. So every request, real or not, costs a database read,
 * and when a `github_app` row exists it costs THREE `decryptSecret` calls, each
 * of which runs `scryptSync`. That function is deliberately expensive, which is
 * the right property for a password hash and the wrong one to run three times
 * per unauthenticated request: it hands anyone who can reach the URL a cheap way
 * to spend a lot of our CPU.
 *
 * Not live for us, verified rather than assumed: production holds **zero**
 * `github_app` rows (checked directly against `specboard-prod-db`), so
 * credentials come from Fly secrets and the cheap env path answers. 89 webhook
 * deliveries have arrived, so the endpoint is genuinely exercised, just not on
 * the expensive branch. It is live for any self-host that used the in-app
 * manifest flow, which is the flow we recommend.
 *
 * ── Why a TTL rather than caching for ever ─────────────────────────────────
 * Credentials change: `saveCredentials` replaces them during setup, and an
 * operator may rotate a webhook secret. A permanent cache would serve the old
 * webhook secret until the next deploy, which looks exactly like GitHub
 * suddenly sending bad signatures. `saveCredentials` clears the cache directly
 * for the in-process case, and the TTL bounds the window for the other machine
 * in a two-machine deployment.
 *
 * The cache holds decrypted secrets in memory. That is not a new exposure:
 * `getGithubApp` already keeps the same material in a live App instance, and
 * anything that can read this process's heap can read the decryption key from
 * its environment anyway.
 */
const CREDENTIALS_TTL_MS = 60_000;
let credentialsCache: {
  value: GithubAppCredentials | null;
  expiresAt: number;
} | null = null;

/** Drop the memoized credentials. Exported for tests and for saves. */
export function clearCredentialsCache(): void {
  credentialsCache = null;
}

/** Load + decrypt the stored App credentials, or null if none saved. */
export async function getStoredCredentials(
  db: Database,
): Promise<GithubAppCredentials | null> {
  const now = Date.now();
  if (credentialsCache && credentialsCache.expiresAt > now) {
    return credentialsCache.value;
  }

  let rows;
  try {
    rows = await db
      .select()
      .from(githubApp)
      .orderBy(desc(githubApp.createdAt))
      .limit(1);
  } catch (err) {
    // Before migration 0003 the table doesn't exist yet — degrade to env creds
    // rather than 500 the Repositories page / webhook.
    if (isMissingTable(err)) return null;
    throw err;
  }
  const row = rows[0];
  // The absence of a row is cached too, which is the case that matters for us:
  // it is the one production takes on every webhook delivery.
  const value: GithubAppCredentials | null = row
    ? {
        appId: row.appId,
        slug: row.slug,
        clientId: row.clientId,
        clientSecret: row.clientSecret ? decryptSecret(row.clientSecret) : null,
        privateKey: decryptSecret(row.privateKey),
        webhookSecret: decryptSecret(row.webhookSecret),
      }
    : null;
  credentialsCache = { value, expiresAt: now + CREDENTIALS_TTL_MS };
  return value;
}

/** Encrypt + persist App credentials, replacing any existing ones (singleton). */
export async function saveCredentials(
  db: Database,
  creds: GithubAppCredentials,
): Promise<void> {
  // Cleared before the write as well as after: a read racing this save should
  // miss the cache and go to the database rather than be served a value that is
  // about to be wrong.
  clearCredentialsCache();
  await db.delete(githubApp);
  await db.insert(githubApp).values({
    appId: creds.appId,
    slug: creds.slug,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret ? encryptSecret(creds.clientSecret) : null,
    privateKey: encryptSecret(creds.privateKey),
    webhookSecret: encryptSecret(creds.webhookSecret),
  });
  clearCredentialsCache();
}

/**
 * The App instance for minting installation tokens, or null when GitHub isn't
 * configured at all. Prefers stored credentials over env.
 */
export async function getGithubApp(db: Database): Promise<ReturnType<typeof githubAppFrom> | null> {
  const stored = await getStoredCredentials(db);
  if (stored) return githubAppFrom({ appId: stored.appId, privateKey: stored.privateKey });
  return githubAppFromEnv();
}

/**
 * The App's OAuth client credentials for the "identify users" flow, used by
 * the install callback to verify GitHub account ownership before binding an
 * installation. Prefers stored credentials (self-host manifest flow), falling
 * back to `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` (hosted). Null
 * when neither is complete; the install flow fails closed in that case.
 */
export async function getGithubOauthCredentials(
  db: Database,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const stored = await getStoredCredentials(db);
  if (stored?.clientId && stored.clientSecret) {
    return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  }
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

/** The webhook signing secret (stored or env), or null when unconfigured. */
export async function getWebhookSecret(db: Database): Promise<string | null> {
  const stored = await getStoredCredentials(db);
  if (stored) return stored.webhookSecret;
  return process.env.GITHUB_WEBHOOK_SECRET ?? null;
}

/** The App slug used to build the install URL (stored or env), or null. */
export async function getGithubAppSlug(db: Database): Promise<string | null> {
  // A dummy slug in E2E so the install URL renders like production.
  if (isE2E()) return "specboard-e2e";
  const stored = await getStoredCredentials(db);
  if (stored) return stored.slug;
  return process.env.NEXT_PUBLIC_GITHUB_APP_SLUG?.trim() || null;
}

/** Whether the deployment has GitHub credentials (stored or env). */
export async function isGithubConfigured(db: Database): Promise<boolean> {
  // In E2E, GitHub is faked (see github-e2e.ts): report configured so the
  // onboarding import panel renders without real credentials.
  if (isE2E()) return true;
  return (await getGithubApp(db)) !== null;
}
