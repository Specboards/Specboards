import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style webhook signing. We HMAC-SHA256 over `"{timestamp}.{rawBody}"`
 * with the endpoint's secret and ship the result as an `X-Specboards-Signature:
 * t=<unix>,v1=<hex>` header. Binding the timestamp into the signed string lets
 * consumers reject replays outside a short window, and signing the *raw* body
 * (not a re-serialization) means verification is byte-exact.
 */

/** Hex HMAC-SHA256 of `"{timestamp}.{rawBody}"` under `secret`. */
function signPayload(
  secret: string,
  rawBody: string,
  timestampSeconds: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
}

/** The full `X-Specboards-Signature` header value for a delivery. */
export function signatureHeader(
  secret: string,
  rawBody: string,
  timestampSeconds: number,
): string {
  return `t=${timestampSeconds},v1=${signPayload(secret, rawBody, timestampSeconds)}`;
}

/**
 * Verify a signature header the way we document it for consumers, so our own
 * "send test event" round-trips and the scheme stays honest. Constant-time
 * compare; rejects timestamps outside `toleranceSeconds` (default 5 min).
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = signPayload(secret, rawBody, t);
  // timingSafeEqual throws on length mismatch, so guard first.
  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
