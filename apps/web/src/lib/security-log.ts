/**
 * Structured security telemetry. One place to emit `[security:<event>]` lines
 * so rate-limit rejections, oversized/over-batched requests, and repeated
 * invalid webhook signatures are greppable and consistently shaped, rather
 * than scattered ad-hoc `console` calls. Fields are appended as `key=value`
 * pairs; values are coerced to strings and newline-stripped so one event is
 * always one log line.
 */

export type SecurityEvent =
  | "rate-limit-exceeded"
  | "request-oversized"
  | "batch-oversized"
  | "webhook-signature-invalid"
  // A correctly-signed GitHub delivery whose id we had already processed:
  // either a replay, or one of GitHub's own retries. Expected occasionally;
  // a burst of them is someone re-sending captured deliveries.
  | "webhook-delivery-replayed"
  // A GitHub delivery with no usable `x-github-delivery` header. Every genuine
  // delivery carries one, so this is either a forgery or a broken sender.
  | "webhook-delivery-id-missing"
  // A GitHub account-connect callback whose state did not match the cookie.
  // Worth a line because this flow ends in storing a repo-write credential.
  | "github-user-connect-state-mismatch"
  // An MCP OAuth connection carrying no recorded grant tried to call. Either it
  // predates the consent screen asking, or its consent never wrote a binding.
  // The connection is retired here and must consent again, so a burst of these
  // is the one-time migration of legacy connections working, and a steady
  // trickle afterwards is worth looking at.
  | "mcp-connection-ungranted";

export function logSecurityEvent(
  event: SecurityEvent,
  fields: Record<string, string | number | undefined> = {},
): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, "_")}`);
  console.warn(`[security:${event}]${parts.length ? " " + parts.join(" ") : ""}`);
}
