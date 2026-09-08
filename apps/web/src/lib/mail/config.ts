import { mailSettings, type Database } from "@specboards/db";

import { decryptSecret } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { isMultiTenant } from "@/lib/tenancy";
import type {
  MailConfig,
  ResolvedMail,
  SmtpSecurity,
} from "@/lib/mail/types";

/**
 * What this deployment sends mail with, or null when it cannot send at all.
 *
 * ── Precedence, and why it runs this way round ──────────────────────────────
 * Stored settings win over env, and env is the fallback. That order is what
 * "an admin can change it without a redeploy" requires: if env won, an
 * operator who had ever set `POSTMARK_SERVER_TOKEN` could never move off it
 * from the UI, which is the situation this feature exists to end.
 *
 * On a multi-tenant deployment the stored row is not read at all. Not
 * "ignored if absent" but never consulted: mail transport is the credential
 * every transactional message leaves through, and a tenant-facing surface that
 * could set it would let one workspace owner re-point every other tenant's
 * verification and invitation mail. The settings screen is not offered there
 * either, so this is the second of two locks rather than the only one.
 *
 * Not cached. A resolution is one indexed read of a single-row table, and an
 * operator who has just fixed their SMTP password is the person least willing
 * to be told to wait for a cache to turn over.
 */
export async function resolveMailConfig(): Promise<ResolvedMail | null> {
  if (!isMultiTenant()) {
    const db = getDb();
    if (db) {
      const stored = await readStoredConfig(db);
      if (stored) return { config: stored, source: "settings" };
    }
  }
  const env = configFromEnv();
  return env ? { config: env, source: "env" } : null;
}

/** The row, decrypted, or null when there is none or it is unusable. */
async function readStoredConfig(db: Database): Promise<MailConfig | null> {
  const [row] = await db.select().from(mailSettings).limit(1);
  if (!row) return null;

  if (row.transport === "postmark") {
    if (!row.postmarkToken) return null;
    return {
      kind: "postmark",
      from: row.fromAddress,
      token: decryptSecret(row.postmarkToken),
    };
  }
  if (row.transport === "smtp") {
    if (!row.smtpHost || row.smtpPort == null || !row.smtpSecurity) return null;
    return {
      kind: "smtp",
      from: row.fromAddress,
      host: row.smtpHost,
      port: row.smtpPort,
      security: row.smtpSecurity as SmtpSecurity,
      username: row.smtpUsername,
      password: row.smtpPassword ? decryptSecret(row.smtpPassword) : null,
    };
  }
  // A transport this build does not know. The column is text on purpose so a
  // newer version can add one; an older version reading that row should fall
  // back to env rather than throw on every send.
  return null;
}

/**
 * The env configuration, which is how every deployment worked before this
 * table existed and how the hosted ones still work.
 *
 * `SPECBOARDS_SMTP_HOST` is offered as well as the Postmark pair so that a
 * self-hosted operator can configure SMTP entirely from their compose file,
 * without a first run through the UI. That matters for the air-gapped case,
 * where the first mail the instance needs to send is the verification link for
 * the account that would have configured it.
 */
function configFromEnv(): MailConfig | null {
  const from = process.env.EMAIL_FROM;
  if (!from) return null;

  const host = process.env.SPECBOARDS_SMTP_HOST;
  if (host) {
    const port = Number(process.env.SPECBOARDS_SMTP_PORT ?? 587);
    const security = process.env.SPECBOARDS_SMTP_SECURITY;
    return {
      kind: "smtp",
      from,
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      security:
        security === "tls" || security === "none" ? security : "starttls",
      username: process.env.SPECBOARDS_SMTP_USERNAME ?? null,
      password: process.env.SPECBOARDS_SMTP_PASSWORD ?? null,
    };
  }

  const token = process.env.POSTMARK_SERVER_TOKEN;
  return token ? { kind: "postmark", from, token } : null;
}
