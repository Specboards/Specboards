import { Agent, fetch as undiciFetch } from "undici";

import { signatureHeader } from "@/lib/webhooks/signing";
import { resolveValidatedTarget, type PinnedAddress } from "@/lib/webhooks/ssrf";
import type { WebhookEnvelope } from "@/lib/webhooks/types";

/**
 * POST one signed envelope to an endpoint. Shared by the outbox drainer and the
 * "send test event" action so signing, headers, the SSRF re-check, and the
 * timeout are identical for real and test deliveries. Takes the *plaintext*
 * secret (callers decrypt). `blocked` marks a terminal SSRF rejection the caller
 * should not retry.
 *
 * The target host is resolved and validated once, and the TCP connection is
 * pinned to exactly the address(es) that passed validation (see `pinnedAgent`),
 * so DNS cannot rebind to a private address between the check and the connect.
 * TLS SNI / certificate validation still use the original hostname.
 */

const TIMEOUT_MS = 5_000;

export type SendResult =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode: number | null; error: string; blocked?: boolean };

/**
 * An undici dispatcher whose DNS lookup always returns the pre-validated
 * address(es), never re-resolving. This is what closes the DNS-rebinding gap:
 * undici connects to what we already checked, not to a fresh lookup.
 */
export function pinnedAgent(addresses: PinnedAddress[]): Agent {
  return new Agent({
    connect: {
      timeout: TIMEOUT_MS,
      lookup(_hostname, options, callback) {
        if (options && options.all) {
          callback(null, addresses as never);
        } else {
          const first = addresses[0]!;
          // dns.lookup callback shape when `all` is false.
          (callback as (e: Error | null, a: string, f: number) => void)(
            null,
            first.address,
            first.family,
          );
        }
      },
    },
  });
}

export async function postSignedEnvelope(
  url: string,
  secret: string,
  envelope: WebhookEnvelope,
): Promise<SendResult> {
  const target = await resolveValidatedTarget(url);
  if (!target.ok) {
    return { ok: false, statusCode: null, error: target.reason, blocked: true };
  }

  const rawBody = JSON.stringify(envelope);
  const t = Math.floor(Date.now() / 1000);

  // No addresses => allow-private mode (self-host / e2e): connect normally.
  const agent = target.addresses.length > 0 ? pinnedAgent(target.addresses) : undefined;

  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Specboard-Webhooks/1.0",
        "X-Specboard-Event": envelope.type,
        "X-Specboard-Delivery": envelope.id,
        "X-Specboard-Signature": signatureHeader(secret, rawBody, t),
      },
      body: rawBody,
      redirect: "manual", // never follow a 30x to a possibly-private target
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(agent ? { dispatcher: agent } : {}),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status };
    }
    return {
      ok: false,
      statusCode: res.status,
      error: `Endpoint returned HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      error: err instanceof Error ? err.message : "Request failed.",
    };
  } finally {
    // Release the pinned connection pool; each delivery uses a fresh agent.
    await agent?.close().catch(() => {});
  }
}
