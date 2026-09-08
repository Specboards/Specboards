import {
  MailError,
  type OutboundEmail,
  type PostmarkConfig,
} from "@/lib/mail/types";

/**
 * The Postmark transport: an HTTP POST, no SDK.
 *
 * This is the code that used to be the whole of `sendEmail`, moved behind the
 * transport interface with its behaviour intact. The hosted deployments send
 * through it and must keep working unchanged, so the request shape, the
 * `ErrorCode` handling and the failure text are deliberately the same.
 */

/** Postmark error codes worth naming, so the settings screen can point at the
 * field that is wrong rather than reporting "send failed".
 * https://postmarkapp.com/developer/api/overview#error-codes */
const CODE_KINDS: Record<number, MailError["kind"]> = {
  10: "auth-rejected", // Bad or missing API token
  300: "rejected-recipient", // Invalid email request
  400: "rejected-sender", // Sender signature not confirmed
  401: "rejected-sender", // Sender signature not found
  405: "rejected-recipient", // Not allowed to send
  406: "rejected-recipient", // Inactive recipient
};

export async function sendViaPostmark(
  config: PostmarkConfig,
  message: OutboundEmail,
): Promise<void> {
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": config.token,
    },
    body: JSON.stringify({
      From: config.from,
      To: message.to,
      Subject: message.subject,
      TextBody: message.textBody,
      HtmlBody: message.htmlBody,
      MessageStream: "outbound",
    }),
  });

  // Postmark returns HTTP 200 with `ErrorCode: 0` on success, but some failures
  // (an inactive or suppressed recipient, say) also come back 200 with a
  // non-zero ErrorCode, which an `res.ok` check alone would read as success.
  // Read the body once and treat any non-zero ErrorCode as a failure too.
  const raw = await res.text().catch(() => "");
  let parsed: { ErrorCode?: number; Message?: string } | null = null;
  try {
    parsed = raw
      ? (JSON.parse(raw) as { ErrorCode?: number; Message?: string })
      : null;
  } catch {
    parsed = null;
  }
  const errorCode =
    parsed != null && typeof parsed.ErrorCode === "number" && parsed.ErrorCode !== 0
      ? parsed.ErrorCode
      : null;

  if (!res.ok || errorCode !== null) {
    const code = errorCode !== null ? `, code ${errorCode}` : "";
    throw new MailError(
      (errorCode !== null ? CODE_KINDS[errorCode] : undefined) ??
        (res.status === 401 ? "auth-rejected" : "unknown"),
      `Postmark send failed (${res.status}${code}): ${parsed?.Message ?? raw}`,
    );
  }
}
