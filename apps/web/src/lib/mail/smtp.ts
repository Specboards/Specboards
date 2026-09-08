import { createTransport } from "nodemailer";

import { assertReachableSmtpHost } from "@/lib/mail/egress";
import { MailError, type OutboundEmail, type SmtpConfig } from "@/lib/mail/types";

/**
 * The SMTP transport.
 *
 * SMTP is the lowest common denominator every on-prem customer can already
 * satisfy: they have a relay, or their platform team will give them one, and
 * most enterprises have a policy that mail must leave through their own
 * infrastructure. It is also the only option that works air-gapped, where
 * api.postmarkapp.com is not merely slow but unreachable.
 *
 * nodemailer rather than a hand-written client. SMTP is a stateful,
 * multi-round-trip protocol with three different ways to negotiate TLS and a
 * long tail of relay quirks; writing that here would be a worse version of a
 * library that already exists. It is used only by this transport, so the
 * Postmark path takes no new dependency.
 */

/** How long to wait on a relay before calling it unreachable. Short on
 * purpose: this runs inside a request that somebody is waiting on, and a
 * hanging relay should present as a failure they can read rather than as the
 * page never loading. */
const TIMEOUT_MS = 15_000;

export async function sendViaSmtp(
  config: SmtpConfig,
  message: OutboundEmail,
): Promise<void> {
  // Re-checked on every send, not only when the settings were saved. A row
  // written while a deployment was single-tenant must stop working the moment
  // that changes, and a hostname that resolved publicly at save time can
  // resolve somewhere private later.
  const reachable = await assertReachableSmtpHost(config.host);
  if (!reachable.ok) {
    throw new MailError("connection-refused", reachable.reason);
  }

  const transporter = createTransport({
    host: config.host,
    port: config.port,
    // nodemailer's `secure` means implicit TLS from the first byte, which is
    // the 465 style. STARTTLS upgrades a plaintext connection instead, and is
    // expressed as `secure: false` plus `requireTLS`, so that an unencrypted
    // fallback is refused rather than silently accepted.
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.textBody,
      html: message.htmlBody,
      headers: message.headers,
    });
  } catch (err) {
    throw asMailError(err);
  } finally {
    transporter.close();
  }
}

/**
 * Turn a nodemailer failure into something an operator can act on.
 *
 * The whole reason the settings screen has a test button is that these four
 * failures are indistinguishable from "the app is broken" when they are
 * reported as one generic error, and each one points at a different field on
 * the form. nodemailer surfaces them as an SMTP response code plus a Node
 * socket error code, so both are worth reading.
 */
function asMailError(err: unknown): MailError {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const message = e?.message ?? "The relay refused the message.";
  const status = e?.responseCode;

  if (e?.code === "EAUTH" || status === 535 || status === 534) {
    return new MailError(
      "auth-rejected",
      `The relay rejected those credentials: ${message}`,
    );
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT" || e?.code === "EDNS") {
    return new MailError(
      "connection-refused",
      `Could not reach the relay: ${message}`,
    );
  }
  if (e?.code === "ESOCKET" || e?.code === "ETLS" || /tls|ssl|certificate/i.test(message)) {
    return new MailError(
      "tls",
      `TLS negotiation failed. Check the port and the security setting: ${message}`,
    );
  }
  // 550/553 on the sender is a relay refusing to send *as* this address, which
  // is a different fix (a sender the relay is willing to accept) from a bad
  // recipient, and by far the more common on-prem mistake.
  if (status === 550 || status === 553) {
    return new MailError(
      "rejected-sender",
      `The relay refused the sender address: ${message}`,
    );
  }
  return new MailError("unknown", message);
}
