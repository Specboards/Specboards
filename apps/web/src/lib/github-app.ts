import { desc, githubApp, type Database } from "@specboard/db";
import { githubAppFrom, githubAppFromEnv } from "@specboard/git";

import { decryptSecret, encryptSecret } from "@/lib/crypto";

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
  privateKey: string;
  webhookSecret: string;
}

/** True for a Postgres "relation does not exist" error (migration not applied). */
function isMissingTable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "42P01";
}

/** Load + decrypt the stored App credentials, or null if none saved. */
export async function getStoredCredentials(
  db: Database,
): Promise<GithubAppCredentials | null> {
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
  if (!row) return null;
  return {
    appId: row.appId,
    slug: row.slug,
    clientId: row.clientId,
    privateKey: decryptSecret(row.privateKey),
    webhookSecret: decryptSecret(row.webhookSecret),
  };
}

/** Encrypt + persist App credentials, replacing any existing ones (singleton). */
export async function saveCredentials(
  db: Database,
  creds: GithubAppCredentials,
): Promise<void> {
  await db.delete(githubApp);
  await db.insert(githubApp).values({
    appId: creds.appId,
    slug: creds.slug,
    clientId: creds.clientId,
    privateKey: encryptSecret(creds.privateKey),
    webhookSecret: encryptSecret(creds.webhookSecret),
  });
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

/** The webhook signing secret (stored or env), or null when unconfigured. */
export async function getWebhookSecret(db: Database): Promise<string | null> {
  const stored = await getStoredCredentials(db);
  if (stored) return stored.webhookSecret;
  return process.env.GITHUB_WEBHOOK_SECRET ?? null;
}

/** The App slug used to build the install URL (stored or env), or null. */
export async function getGithubAppSlug(db: Database): Promise<string | null> {
  const stored = await getStoredCredentials(db);
  if (stored) return stored.slug;
  return process.env.NEXT_PUBLIC_GITHUB_APP_SLUG?.trim() || null;
}

/** Whether the deployment has GitHub credentials (stored or env). */
export async function isGithubConfigured(db: Database): Promise<boolean> {
  return (await getGithubApp(db)) !== null;
}
