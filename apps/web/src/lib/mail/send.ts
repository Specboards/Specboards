import { resolveMailConfig } from "@/lib/mail/config";
import { sendViaPostmark } from "@/lib/mail/postmark";
import { sendViaSmtp } from "@/lib/mail/smtp";
import {
  MailError,
  type MailConfig,
  type OutboundEmail,
} from "@/lib/mail/types";

/**
 * Send one message through whichever transport this deployment has.
 *
 * ── On the dropped-mail behaviour ───────────────────────────────────────────
 * With no transport at all this logs and returns rather than throwing, and
 * that is deliberate even though three cards have asked for it to fail loudly.
 * Throwing here today would break self-host sign-up outright: with no mail
 * configured, Better Auth stops requiring verification (see
 * `canRequireEmailVerification` in auth.ts) precisely so a fresh instance can
 * be claimed, and the send it still attempts must not fail the request.
 *
 * What the "fail loudly" requirement actually wants is for the operator to
 * *know*, and that is now answered a better way: `mailStatus()` reports the
 * absence, the settings screen shows it, and `sendEmail` says which message it
 * dropped rather than only that one was dropped. A thrown error would have put
 * the news in a stack trace nobody reads, at the cost of the install working.
 *
 * The remaining half of that requirement, that a *configured* transport never
 * report success when the send failed, is met: both transports throw.
 */
export async function dispatchEmail(message: OutboundEmail): Promise<void> {
  const resolved = await resolveMailConfig();
  if (!resolved) {
    console.warn(
      `[mail] no transport configured; dropping "${message.subject}" to ${message.to}. ` +
        "Set EMAIL_FROM with either POSTMARK_SERVER_TOKEN or SPECBOARDS_SMTP_HOST, " +
        "or configure mail in Settings.",
    );
    return;
  }
  await sendWith(resolved.config, message);
}

/** Send through an explicit configuration, bypassing resolution. The test-send
 * action uses this so an admin can try settings they have not saved yet. */
export async function sendWith(
  config: MailConfig,
  message: OutboundEmail,
): Promise<void> {
  if (config.kind === "postmark") return sendViaPostmark(config, message);
  if (config.kind === "smtp") return sendViaSmtp(config, message);
  throw new MailError("not-configured", "No mail transport is configured.");
}

/** What the settings screen and the operator need to know about mail. */
export interface MailStatus {
  configured: boolean;
  transport: MailConfig["kind"] | null;
  from: string | null;
  /**
   * Where the configuration came from. `env` means it cannot be changed from
   * the UI, which is the normal state on a hosted deployment and the thing an
   * operator most needs told before they go looking for a form.
   */
  source: "env" | "settings" | null;
}

export async function mailStatus(): Promise<MailStatus> {
  const resolved = await resolveMailConfig();
  if (!resolved) {
    return { configured: false, transport: null, from: null, source: null };
  }
  return {
    configured: true,
    transport: resolved.config.kind,
    from: resolved.config.from,
    source: resolved.source,
  };
}
