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
  | "webhook-signature-invalid";

export function logSecurityEvent(
  event: SecurityEvent,
  fields: Record<string, string | number | undefined> = {},
): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, "_")}`);
  console.warn(`[security:${event}]${parts.length ? " " + parts.join(" ") : ""}`);
}
