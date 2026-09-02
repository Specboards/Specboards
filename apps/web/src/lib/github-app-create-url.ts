/**
 * The link that opens GitHub's "New GitHub App" page with every field this
 * instance needs already filled in.
 *
 * GitHub supports prefilling that form from query parameters, including the
 * permissions. That turns the manual path from a transcription exercise (seven
 * URLs and checkboxes, then six permissions spread across two collapsed
 * groups) into: open the link, press Create. The permissions are the part that
 * matters most, because getting one wrong is not visible at creation time. It
 * surfaces later as an install that fails at the last step, with nothing on
 * screen connecting the failure to the checkbox that caused it.
 *
 * These parameter names are GitHub's, not ours, so a rename upstream would
 * silently stop prefilling that one field. The card therefore still SHOWS the
 * values it expects, as something to confirm rather than something to type: if
 * this ever drifts, the operator sees a mismatch instead of a working-looking
 * app that cannot install.
 */
export function githubAppCreateUrl({
  org,
  origin,
  name,
  webhookActive,
}: {
  /** Organization login, or empty for a personal account. */
  org: string;
  /** This instance's public origin, e.g. `https://specboards.example.com`. */
  origin: string;
  /** The App's display name. Must be unique across all of GitHub. */
  name: string;
  /**
   * Whether to arm the webhook. False on an origin GitHub cannot reach, where
   * a webhook would only produce failed deliveries: the app still works, it
   * just syncs on a schedule rather than on push.
   */
  webhookActive: boolean;
}): string {
  const trimmed = org.trim();
  const base = trimmed
    ? `https://github.com/organizations/${encodeURIComponent(trimmed)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  const params = new URLSearchParams({
    name,
    url: origin,
    setup_url: `${origin}/api/v1/github/setup`,
    // Without this GitHub does not return to us after a repository is added or
    // removed, so the change is invisible here until the next scheduled sync.
    setup_on_update: "true",
    // Single-tenant: this App belongs to one account and should not be
    // installable elsewhere.
    public: "false",
    webhook_active: String(webhookActive),
    // Administration is what lets Specboards create the spec repo on request;
    // Members is what lets it check that whoever installs the App actually
    // administers the account, which every organization install depends on.
    administration: "write",
    contents: "write",
    issues: "read",
    metadata: "read",
    pull_requests: "write",
    members: "read",
  });
  // Repeated-key parameter, so it cannot go in the object literal above.
  params.append("callback_urls[]", `${origin}/api/v1/github/oauth/callback`);

  if (webhookActive) {
    // Must match the route at app/api/webhooks/github. Prefilling a wrong URL
    // would be worse than prefilling none: GitHub accepts it, the App looks
    // correctly configured, and every delivery 404s silently.
    params.set("webhook_url", `${origin}/api/webhooks/github`);
    for (const event of ["push", "pull_request", "issues"]) {
      params.append("events[]", event);
    }
  }

  return `${base}?${params.toString()}`;
}
