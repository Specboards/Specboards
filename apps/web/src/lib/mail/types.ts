/**
 * The mail transport vocabulary.
 *
 * `sendEmail(OutboundEmail)` was already the entire outbound surface, which is
 * why making Postmark one transport rather than the transport is mostly
 * restructuring. Everything below exists so that a second implementation can
 * exist at all; the callers in `auth.ts`, `invitations-service.ts` and the
 * access-request route are unchanged and still import from `lib/email.ts`.
 */

/** How an SMTP connection is secured. */
export const SMTP_SECURITIES = ["tls", "starttls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

export interface OutboundEmail {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  /**
   * Extra message headers, for the handful of things that have to be a header
   * rather than a line of copy.
   *
   * Today that is one-click unsubscribe: `List-Unsubscribe` and
   * `List-Unsubscribe-Post` (RFC 8058) are what put the unsubscribe control in
   * the mail client's own chrome, and the large mailbox providers now expect
   * bulk senders to honour them. A link in the body alone is not the same
   * thing, because the button people actually reach for is the one their
   * client draws.
   *
   * Every transport has to carry these or the guarantee is only true on some
   * deployments, which is why this is on the shared shape rather than a
   * Postmark argument.
   */
  headers?: Record<string, string>;
}

export interface PostmarkConfig {
  kind: "postmark";
  from: string;
  token: string;
}

export interface SmtpConfig {
  kind: "smtp";
  from: string;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
}

export type MailConfig = PostmarkConfig | SmtpConfig;

/**
 * A resolved configuration plus where it came from.
 *
 * The source is not bookkeeping: it is what the settings screen shows an
 * operator, and it is the difference between "mail is broken" and "mail is
 * configured somewhere you cannot edit from here". A hosted deployment reads
 * `env` and offers no form; a self-hosted one that has saved settings reads
 * `settings` and can change them without a redeploy.
 */
export interface ResolvedMail {
  config: MailConfig;
  source: "env" | "settings";
}

/**
 * Why a send could not happen, in terms an operator can act on.
 *
 * Mail misconfiguration presents identically to the app being broken: wrong
 * host, wrong port, a TLS mismatch and a relay refusing the sender all look
 * like "it didn't work". These are the categories worth telling apart, because
 * each one points at a different field on the form.
 */
type MailFailureKind =
  | "not-configured"
  | "auth-rejected"
  | "connection-refused"
  | "tls"
  | "rejected-sender"
  | "rejected-recipient"
  | "unknown";

export class MailError extends Error {
  readonly kind: MailFailureKind;
  constructor(kind: MailFailureKind, message: string) {
    super(message);
    this.name = "MailError";
    this.kind = kind;
  }
}
