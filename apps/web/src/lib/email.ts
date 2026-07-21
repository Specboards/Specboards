/**
 * Outbound email via Postmark (https://postmarkapp.com).
 *
 * Configured entirely by env so self-host works without it:
 * - `POSTMARK_SERVER_TOKEN` — server API token; unset = email disabled,
 *   sends become logged no-ops (sign-up still works, verification links
 *   are just never delivered).
 * - `EMAIL_FROM` — verified sender signature / domain address,
 *   e.g. `Specboards <no-reply@specboard.ai>`.
 *
 * Uses Postmark's HTTP API directly — no SDK dependency.
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
}

/** Escape a string for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A branded, single-action transactional email. The call-to-action is a
 * clickable button (and a linked fallback) so the recipient never sees the
 * raw token URL. Returns matching plain-text and HTML bodies — the plain-text
 * still spells the link out for clients that strip HTML.
 */
export function renderActionEmail(opts: {
  /** Recipient's display name, for the greeting. */
  name: string;
  /** One or two sentences shown above the button. */
  intro: string;
  /** Button text, e.g. "Verify email". */
  action: string;
  /** Destination URL the button and fallback link point to. */
  url: string;
  /** Optional reassurance line shown in muted text below the button. */
  footer?: string;
}): { textBody: string; htmlBody: string } {
  const { name, intro, action, url, footer } = opts;

  const textBody = [
    `Hi ${name},`,
    "",
    intro,
    "",
    url,
    ...(footer ? ["", footer] : []),
  ].join("\n");

  const safeUrl = escapeHtml(url);
  const htmlBody = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e5e5e5;">
            <tr>
              <td style="padding:32px 32px 24px;">
                <p style="margin:0 0 16px;font-size:16px;font-weight:600;">Specboards</p>
                <p style="margin:0 0 8px;font-size:15px;">Hi ${escapeHtml(name)},</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#444;">${escapeHtml(intro)}</p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background:#1a1a1a;">
                      <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(action)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#888;">Or paste this link into your browser:<br /><a href="${safeUrl}" style="color:#2563eb;word-break:break-all;">${safeUrl}</a></p>
                ${footer ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#888;">${escapeHtml(footer)}</p>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { textBody, htmlBody };
}

/**
 * A branded, informational email with no call-to-action button: an intro, then
 * an optional list of label/value detail rows (used e.g. for the access-request
 * notification and the requester's confirmation). Returns matching plain-text
 * and HTML bodies.
 */
export function renderInfoEmail(opts: {
  /** Optional greeting name; omitted for internal notifications. */
  name?: string;
  /** One or more intro paragraphs shown at the top. */
  intro: string | string[];
  /** Optional label/value rows rendered as a simple definition list. */
  details?: { label: string; value: string }[];
  /** Optional muted line shown below everything. */
  footer?: string;
}): { textBody: string; htmlBody: string } {
  const { name, intro, details, footer } = opts;
  const intros = Array.isArray(intro) ? intro : [intro];

  const textBody = [
    ...(name ? [`Hi ${name},`, ""] : []),
    ...intros.flatMap((p) => [p, ""]),
    ...(details && details.length
      ? [...details.map((d) => `${d.label}: ${d.value}`), ""]
      : []),
    ...(footer ? [footer] : []),
  ]
    .join("\n")
    .trim();

  const detailRows = (details ?? [])
    .map(
      (d) =>
        `<tr><td style="padding:4px 0;font-size:13px;color:#888;white-space:nowrap;vertical-align:top;">${escapeHtml(
          d.label,
        )}</td><td style="padding:4px 0 4px 16px;font-size:14px;color:#1a1a1a;">${escapeHtml(
          d.value,
        ).replace(/\n/g, "<br />")}</td></tr>`,
    )
    .join("");

  const htmlBody = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e5e5e5;">
            <tr>
              <td style="padding:32px 32px 24px;">
                <p style="margin:0 0 16px;font-size:16px;font-weight:600;">Specboards</p>
                ${name ? `<p style="margin:0 0 8px;font-size:15px;">Hi ${escapeHtml(name)},</p>` : ""}
                ${intros
                  .map(
                    (p) =>
                      `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#444;">${escapeHtml(
                        p,
                      )}</p>`,
                  )
                  .join("")}
                ${
                  detailRows
                    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0;border-top:1px solid #eee;padding-top:8px;">${detailRows}</table>`
                    : ""
                }
                ${footer ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#888;">${escapeHtml(footer)}</p>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { textBody, htmlBody };
}

export async function sendEmail(message: OutboundEmail): Promise<void> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (!token || !from) {
    console.warn(
      `[email] POSTMARK_SERVER_TOKEN/EMAIL_FROM not set; dropping "${message.subject}" to ${message.to}`,
    );
    return;
  }

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-postmark-server-token": token,
    },
    body: JSON.stringify({
      From: from,
      To: message.to,
      Subject: message.subject,
      TextBody: message.textBody,
      HtmlBody: message.htmlBody,
      MessageStream: "outbound",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Postmark send failed (${res.status}): ${detail}`);
  }
}
