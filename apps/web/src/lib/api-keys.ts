import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, apiKeys, eq, isNull, sql, users, type Database } from "@specboard/db";

import type { SessionUser } from "@/lib/auth-session";

/**
 * Personal API keys for the CLI. The plaintext key is shown to the user exactly
 * once (at creation); we persist only its SHA-256 hash. A key authenticates as
 * its owning user, so it inherits that user's workspace membership and role.
 *
 * Format: `sb_` + 43 url-safe base64 chars (32 random bytes). The leading
 * slice is stored as `prefix` for display ("sb_a1b2c3d4…"); it is not secret.
 */

const KEY_PREFIX = "sb_";
const PREFIX_DISPLAY_LEN = 11; // "sb_" + 8 chars

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface GeneratedApiKey {
  id: string;
  /** The full plaintext key. Returned once, never stored. */
  key: string;
  name: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Public (non-secret) view of a stored key, for listing in settings. */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Create a new key for `userId`. Returns the plaintext exactly once. */
export async function createApiKey(
  db: Database,
  userId: string,
  name: string,
  expiresAt: Date | null = null,
): Promise<GeneratedApiKey> {
  const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
  const prefix = secret.slice(0, PREFIX_DISPLAY_LEN);
  const [row] = await db
    .insert(apiKeys)
    .values({ userId, name, prefix, keyHash: hashKey(secret), expiresAt })
    .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });
  return { id: row!.id, key: secret, name, prefix, createdAt: row!.createdAt, expiresAt };
}

/** List a user's keys (newest first), without any secret material. */
export async function listApiKeys(db: Database, userId: string): Promise<ApiKeySummary[]> {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(sql`${apiKeys.createdAt} desc`);
}

/** Revoke one of the user's keys. Returns true if a live key was revoked. */
export async function revokeApiKey(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/** The header a CLI sends its key in. */
const API_KEY_HEADER = "x-api-key";

/** Pull a raw key from the request: `x-api-key` or `Authorization: Bearer sb_…`. */
export function extractApiKey(req: Request): string | null {
  const header = req.headers.get(API_KEY_HEADER);
  if (header && header.startsWith(KEY_PREFIX)) return header.trim();
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.startsWith(KEY_PREFIX)) return token;
  }
  return null;
}

/**
 * Resolve the user a raw API key belongs to, or `null` if the key is missing,
 * malformed, unknown, revoked, or expired. Bumps `lastUsedAt` on success.
 */
export async function verifyApiKeyUser(
  db: Database,
  rawKey: string,
): Promise<SessionUser | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(rawKey);
  const [row] = await db
    .select({
      id: apiKeys.id,
      keyHash: apiKeys.keyHash,
      userId: apiKeys.userId,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!row) return null;
  // Defence in depth: constant-time compare even though the lookup was by hash.
  const a = Buffer.from(row.keyHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user) return null;

  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id));
  return user;
}
