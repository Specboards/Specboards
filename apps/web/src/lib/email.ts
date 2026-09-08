/**
 * Outbound email: the renderers, and the public send surface.
 *
 * The transports live in `lib/mail/` and Postmark is now one of them rather
 * than the only one, so a self-hosted instance can send through its own SMTP
 * relay. This module keeps the surface every caller already imports
 * (`sendEmail`, `isEmailConfigured`, and the two renderers), which is why
 * `auth.ts`, `invitations-service.ts` and the access-request route did not
 * move.
 *
 * Configuration comes from `lib/mail/config.ts`: stored settings on a
 * single-tenant deployment, env otherwise. See there for the precedence and
 * why a hosted deployment never reads the stored row.
 */

import { dispatchEmail } from "@/lib/mail/send";
import type { OutboundEmail } from "@/lib/mail/types";

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
  /**
   * Secondary links rendered small, below everything else.
   *
   * Separate from `footer` because these have to be clickable. The footer is
   * escaped prose; a URL pasted into it arrives as text. Notification mail
   * needs a way to reach settings and to unsubscribe, and both of those are
   * the sort of thing somebody looks for at the bottom of a message rather
   * than in the middle of a sentence.
   */
  links?: { label: string; url: string }[];
}): { textBody: string; htmlBody: string } {
  const { name, intro, action, url, footer, links } = opts;

  const textBody = [
    `Hi ${name},`,
    "",
    intro,
    "",
    url,
    ...(footer ? ["", footer] : []),
    ...(links?.length ? ["", ...links.map((l) => `${l.label}: ${l.url}`)] : []),
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
                ${
                  links?.length
                    ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #eee;font-size:12px;line-height:1.6;color:#888;">${links
                        .map(
                          (l) =>
                            `<a href="${escapeHtml(l.url)}" style="color:#888;">${escapeHtml(
                              l.label,
                            )}</a>`,
                        )
                        .join(' <span style="color:#ccc;">|</span> ')}</p>`
                    : ""
                }
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

/**
 * Whether outbound email can actually be delivered, judged from env alone.
 *
 * Both halves of a transport are needed: a Postmark token with no verified
 * sender, or a sender with no token, sends nothing. `SPECBOARDS_SMTP_HOST`
 * counts too, so a self-host configured entirely from its compose file reads
 * as configured.
 *
 * ── Why this does not consult the stored settings ───────────────────────────
 * It is synchronous, and it has one caller that needs it to be: Better Auth's
 * `requireEmailVerification` is fixed when the auth instance is built, and the
 * instance is memoized for the life of the process. Reading a table here would
 * mean making this async and the auth construction with it.
 *
 * The consequence, and it is worth knowing: a self-hosted operator who
 * configures SMTP through Settings does not have verification start being
 * required until the app restarts. The settings screen says so. The coupling
 * itself is what `121e301f` removes, by gating the first-run admin claim on a
 * bootstrap secret rather than on whether mail happens to work, at which point
 * this stops being a security-relevant answer at all.
 */
export function isEmailConfigured(): boolean {
  if (!process.env.EMAIL_FROM) return false;
  return Boolean(
    process.env.POSTMARK_SERVER_TOKEN || process.env.SPECBOARDS_SMTP_HOST,
  );
}

/**
 * Send one message through whichever transport this deployment has.
 *
 * Unchanged as a signature and nearly unchanged in behaviour: a configured
 * transport that fails still throws, and no transport at all still logs and
 * returns. See `lib/mail/send.ts` for why that second case is not an error.
 */
export async function sendEmail(message: OutboundEmail): Promise<void> {
  await dispatchEmail(message);
}
