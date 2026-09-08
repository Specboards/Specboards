import { eq, mailSettings, type Database } from "@specboards/db";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import { resolveMailConfig } from "@/lib/mail/config";
import { assertReachableSmtpHost } from "@/lib/mail/egress";
import { mailStatus, sendWith, type MailStatus } from "@/lib/mail/send";
import {
  MailError,
  SMTP_SECURITIES,
  type MailConfig,
  type SmtpSecurity,
} from "@/lib/mail/types";
import { isMultiTenant } from "@/lib/tenancy";

/**
 * Reading and writing this deployment's mail transport.
 *
 * Admin-gated and single-tenant only. The gate is in two places on purpose:
 * `resolveMailConfig` refuses to *read* a stored row on a multi-tenant
 * deployment, and everything here refuses to serve the surface at all. Mail
 * transport is the credential every transactional message leaves through, so
 * one workspace owner being able to set it would re-point every other tenant's
 * verification and invitation mail at a relay they control.
 */

export class MailSettingsError extends DomainError {}

/** What the settings screen renders. Never carries a credential. */
export interface MailSettingsView {
  /** Whether this deployment offers the form at all. */
  editable: boolean;
  status: MailStatus;
  /** The saved row, with secrets replaced by whether one is set. */
  saved: {
    transport: MailConfig["kind"];
    fromAddress: string;
    hasPostmarkToken: boolean;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecurity: SmtpSecurity | null;
    smtpUsername: string | null;
    hasSmtpPassword: boolean;
  } | null;
}

export interface MailSettingsInput {
  transport: MailConfig["kind"];
  fromAddress: string;
  /** Omit to keep the stored one; a value replaces it. */
  postmarkToken?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurity;
  smtpUsername?: string | null;
  smtpPassword?: string;
}

/**
 * Read a settings body from a request.
 *
 * Here rather than in the route so the save and the test-send parse it
 * identically. A second copy would be a second place for the
 * carry-forward rule (an omitted secret means keep the stored one) to drift,
 * and that rule is the difference between changing a port and silently
 * clearing a password.
 */
export function parseMailSettingsInput(body: unknown): MailSettingsInput {
  const b = body as Record<string, unknown> | null;
  const transport = b?.transport;
  if (transport !== "postmark" && transport !== "smtp") {
    throw new MailSettingsError("Choose a transport.");
  }
  if (typeof b?.fromAddress !== "string") {
    throw new MailSettingsError("Enter a from address.");
  }

  const input: MailSettingsInput = { transport, fromAddress: b.fromAddress };
  if (typeof b.postmarkToken === "string") input.postmarkToken = b.postmarkToken;
  if (typeof b.smtpHost === "string") input.smtpHost = b.smtpHost;
  if (typeof b.smtpPort === "number") input.smtpPort = b.smtpPort;
  if (
    typeof b.smtpSecurity === "string" &&
    (SMTP_SECURITIES as readonly string[]).includes(b.smtpSecurity)
  ) {
    input.smtpSecurity = b.smtpSecurity as SmtpSecurity;
  }
  if (typeof b.smtpUsername === "string") input.smtpUsername = b.smtpUsername;
  if (typeof b.smtpPassword === "string") input.smtpPassword = b.smtpPassword;
  return input;
}

/** Refuse the whole surface where it does not belong. */
function assertEditable(): void {
  if (isMultiTenant()) {
    throw new MailSettingsError(
      "Mail transport is managed by the deployment on a multi-tenant install " +
        "and cannot be changed from here.",
    );
  }
}

export async function getMailSettings(db: Database): Promise<MailSettingsView> {
  const status = await mailStatus();
  if (isMultiTenant()) return { editable: false, status, saved: null };

  const [row] = await db.select().from(mailSettings).limit(1);
  return {
    editable: true,
    status,
    saved: row
      ? {
          transport: row.transport as MailConfig["kind"],
          fromAddress: row.fromAddress,
          // Whether a secret exists, never the secret. Once saved it is not
          // readable back through any path the browser can reach.
          hasPostmarkToken: Boolean(row.postmarkToken),
          smtpHost: row.smtpHost,
          smtpPort: row.smtpPort,
          smtpSecurity: (row.smtpSecurity as SmtpSecurity | null) ?? null,
          smtpUsername: row.smtpUsername,
          hasSmtpPassword: Boolean(row.smtpPassword),
        }
      : null,
  };
}

export async function saveMailSettings(
  db: Database,
  input: MailSettingsInput,
  actorId: string | null,
): Promise<MailSettingsView> {
  assertEditable();
  const { row: clean } = await validate(db, input);

  const [existing] = await db.select().from(mailSettings).limit(1);
  const values = {
    transport: clean.transport,
    fromAddress: clean.fromAddress,
    postmarkToken: clean.postmarkToken,
    smtpHost: clean.smtpHost,
    smtpPort: clean.smtpPort,
    smtpSecurity: clean.smtpSecurity,
    smtpUsername: clean.smtpUsername,
    smtpPassword: clean.smtpPassword,
    updatedBy: actorId,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(mailSettings).set(values).where(eq(mailSettings.id, existing.id));
  } else {
    await db.insert(mailSettings).values(values);
  }
  return getMailSettings(db);
}

/** Forget the stored transport and fall back to env (usually: to nothing). */
export async function clearMailSettings(db: Database): Promise<MailSettingsView> {
  assertEditable();
  await db.delete(mailSettings);
  return getMailSettings(db);
}

/**
 * Send a test message, to the settings being edited rather than the ones
 * saved.
 *
 * Testing before saving is the point. Mail misconfiguration presents
 * identically to the app being broken, and an admin who has to save a wrong
 * password before finding out it is wrong has already replaced a working
 * configuration with a broken one.
 */
export async function sendTestEmail(
  db: Database,
  to: string,
  input?: MailSettingsInput,
): Promise<void> {
  assertEditable();
  const config = input
    ? (await validate(db, input)).config
    : await storedConfig();
  if (!config) {
    throw new MailSettingsError("Configure a transport before sending a test.");
  }

  try {
    await sendWith(config, {
      to,
      subject: "Specboards test email",
      textBody:
        "This is a test from your Specboards mail settings.\n\n" +
        "If you are reading it, the transport works and verification links, " +
        "invitations and notifications will reach people.",
      htmlBody: undefined,
    });
  } catch (err) {
    // Rethrown as a domain error carrying the transport's own classification,
    // so the form can say which field is wrong rather than "send failed".
    if (err instanceof MailError) {
      throw new MailSettingsError(err.message);
    }
    throw err;
  }
}

/** The saved row as a usable config, or null when nothing is stored. */
async function storedConfig(): Promise<MailConfig | null> {
  const resolved = await resolveMailConfig();
  return resolved?.source === "settings" ? resolved.config : null;
}

/** A validated save: the row to store (secrets encrypted) and the same
 * settings as the sender takes them (secrets in the clear), so a test send
 * does not have to encrypt a value and immediately decrypt it again. */
type Validated = { row: CleanSettings; config: MailConfig };

type CleanSettings = {
  transport: MailConfig["kind"];
  fromAddress: string;
  postmarkToken: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: SmtpSecurity | null;
  smtpUsername: string | null;
  smtpPassword: string | null;
};

/**
 * Check the input and carry forward any secret the caller left out.
 *
 * An omitted credential means "keep the one you have", which is what lets an
 * admin change the port without re-typing a password they cannot read back.
 * An empty string is not the same thing and is refused, so a cleared field
 * cannot silently keep working.
 */
async function validate(
  db: Database,
  input: MailSettingsInput,
): Promise<Validated> {
  const from = input.fromAddress?.trim();
  if (!from) throw new MailSettingsError("Enter a from address.");
  // Deliberately loose: a From header may be `Name <addr>` and relays accept
  // more than any regex here would. The test-send is the real check.
  if (!from.includes("@")) {
    throw new MailSettingsError("The from address needs to be an email address.");
  }

  const [existing] = await db.select().from(mailSettings).limit(1);
  /** The stored (encrypted) value and the plaintext, whichever way it arrived. */
  const keep = (
    given: string | undefined,
    stored: string | null,
  ): { stored: string | null; plain: string | null } => {
    if (given === undefined) {
      return { stored, plain: stored ? decryptSecret(stored) : null };
    }
    if (given.trim() === "") {
      throw new MailSettingsError("A credential cannot be set to an empty value.");
    }
    return { stored: encryptSecret(given), plain: given };
  };

  if (input.transport === "postmark") {
    const token = keep(input.postmarkToken, existing?.postmarkToken ?? null);
    if (!token.stored || !token.plain) {
      throw new MailSettingsError("Enter a Postmark server token.");
    }
    return {
      row: {
        transport: "postmark",
        fromAddress: from,
        postmarkToken: token.stored,
        smtpHost: null,
        smtpPort: null,
        smtpSecurity: null,
        smtpUsername: null,
        smtpPassword: null,
      },
      config: { kind: "postmark", from, token: token.plain },
    };
  }

  const host = input.smtpHost?.trim();
  if (!host) throw new MailSettingsError("Enter an SMTP host.");
  const reachable = await assertReachableSmtpHost(host);
  if (!reachable.ok) throw new MailSettingsError(reachable.reason);

  const port = input.smtpPort;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new MailSettingsError("Enter a port between 1 and 65535.");
  }
  const security = input.smtpSecurity;
  if (!security || !(SMTP_SECURITIES as readonly string[]).includes(security)) {
    throw new MailSettingsError("Choose how the connection is secured.");
  }

  const username = input.smtpUsername?.trim() || null;
  const password = keep(input.smtpPassword, existing?.smtpPassword ?? null);
  return {
    row: {
      transport: "smtp",
      fromAddress: from,
      postmarkToken: null,
      smtpHost: host,
      smtpPort: port as number,
      smtpSecurity: security,
      smtpUsername: username,
      smtpPassword: password.stored,
    },
    config: {
      kind: "smtp",
      from,
      host,
      port: port as number,
      security,
      username,
      password: password.plain,
    },
  };
}
