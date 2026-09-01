/**
 * The interstitial that hands GitHub the App manifest.
 *
 * Extracted from the route so the one property that matters can be asserted
 * without a browser: **this page must work with no JavaScript at all.**
 *
 * It previously did not. The page carried an inline `<script>` that filled in
 * the hidden `manifest` field and submitted the form, and the app serves a
 * strict nonce-based CSP with no `'unsafe-inline'`. Hand-written HTML from a
 * route handler has no access to that per-request nonce, so the browser refused
 * the script: the field stayed empty, the form never submitted, and the
 * operator sat on "Redirecting you to GitHub…" indefinitely. `<noscript>` did
 * not save it either, because scripting was enabled, merely refused.
 *
 * So the manifest is server-rendered into the field's `value` and the operator
 * presses a real button. Nothing here depends on scripting, which means no CSP
 * change can silently break it again.
 */

/** HTML-attribute escaping. The manifest is JSON, so quotes matter most. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderManifestForm(input: {
  /** GitHub's App-creation endpoint for the target account. */
  action: string;
  /** CSRF nonce, echoed back to our callback as `state`. */
  nonce: string;
  /** The App manifest, serialised. */
  manifest: unknown;
  /** Target organization, for the confirmation copy; empty for a personal account. */
  org: string;
}): string {
  const manifestValue = attr(JSON.stringify(input.manifest));
  const target = input.org
    ? ` for the <strong style="color:#e6e8eb;">${attr(input.org)}</strong> organization`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Setting up GitHub…</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8eb;">
    <form method="post" action="${attr(input.action)}?state=${attr(input.nonce)}" style="max-width:26rem;padding:2rem;text-align:center;">
      <h1 style="font-size:1.125rem;margin:0 0 .75rem;">Create the Specboards GitHub App</h1>
      <p style="margin:0 0 1.5rem;line-height:1.5;color:#a1a7b0;">
        GitHub will ask you to confirm the app's name and permissions${target}.
        You will come straight back here afterwards.
      </p>
      <input type="hidden" name="manifest" value="${manifestValue}">
      <button type="submit" style="width:100%;padding:.625rem 1rem;font-size:.9375rem;font-weight:500;color:#fff;background:#3d8f4d;border:0;border-radius:.375rem;cursor:pointer;">
        Continue to GitHub
      </button>
    </form>
  </body>
</html>`;
}
