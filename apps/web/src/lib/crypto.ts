import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Authenticated symmetric encryption for secrets at rest (GitHub App private
 * key, webhook secret). AES-256-GCM with a per-value random salt + IV; the key
 * is derived from `BETTER_AUTH_SECRET` via scrypt, so no extra key management.
 *
 * Stored format is a single base64 blob: salt(16) | iv(12) | tag(16) | ct.
 */

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("BETTER_AUTH_SECRET is not set; cannot encrypt secrets.");
  return value;
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(secret(), salt, KEY_LEN);
}

/** Encrypt UTF-8 plaintext, returning a base64 blob safe to store in a column. */
export function encryptSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ciphertext]).toString("base64");
}

/** Decrypt a blob produced by {@link encryptSecret}. Throws if tampered. */
export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
