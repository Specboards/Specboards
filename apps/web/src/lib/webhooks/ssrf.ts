import {
  isBlockedIp,
  resolveTarget,
  type PinnedAddress,
  type TargetResolution,
  type UrlCheck,
} from "@/lib/egress";
import { isMultiTenant } from "@/lib/tenancy";

/**
 * The webhook half of the egress guard: the *policy* for whether a webhook
 * delivery may reach a private address, plus the boot guard that enforces it.
 *
 * The classification and resolution themselves live in `@/lib/egress` and are
 * shared with model provider connections, so there is one place where "can the
 * server call this address" is decided. What stays here is the part that is
 * genuinely webhook-specific, because the answer differs per feature: a
 * self-hosted model endpoint is on a private address by design, a webhook
 * target is not.
 */

export type { PinnedAddress, TargetResolution, UrlCheck };
export { isBlockedIp };

/**
 * Whether the private-target escape hatch applies to this deployment.
 *
 * `SPECBOARDS_WEBHOOK_ALLOW_PRIVATE=1` turns the whole guard off: HTTPS, DNS
 * resolution, the private-range checks and connection pinning. That is
 * legitimate for self-host and the e2e suite, where webhook targets live on the
 * same private network. It is never legitimate on a hosted deployment, where
 * the endpoint URL is supplied per tenant and the app sits inside a network
 * with metadata endpoints and internal services in reach.
 *
 * So the flag is ignored outright in multi-tenant mode, rather than merely
 * discouraged. {@link assertWebhookEgressPolicy} refuses the boot as well, but
 * this is the check that matters at request time: a boot guard cannot help
 * against an env var set on a process already running.
 */
export function allowPrivateWebhookTargets(): boolean {
  if (isMultiTenant()) return false;
  return process.env.SPECBOARDS_WEBHOOK_ALLOW_PRIVATE === "1";
}

/**
 * Boot guard, called from `instrumentation.ts` beside the RLS, origin and
 * local-mode guards. Fails the release when a hosted deployment is configured
 * with the escape hatch set, so the misconfiguration surfaces at deploy time
 * instead of being silently ignored per request.
 *
 * Verified on 2026-08-09: the flag is set on neither `specboard` nor
 * `specboard-test` (both of which run `SPECBOARDS_MULTI_TENANT=true`), so this
 * guard closes a latent hole rather than an open one.
 */
export function assertWebhookEgressPolicy(): void {
  const requested = process.env.SPECBOARDS_WEBHOOK_ALLOW_PRIVATE === "1";
  if (!requested) return;

  if (isMultiTenant()) {
    throw new Error(
      "[security] Refusing to start: SPECBOARDS_WEBHOOK_ALLOW_PRIVATE is set on " +
        "a multi-tenant deployment. That flag disables the webhook SSRF guard " +
        "entirely (HTTPS, DNS, private-range checks and connection pinning), " +
        "and tenants supply their own webhook URLs. Unset it.",
    );
  }
  // Supported single-tenant/self-host, but never something to discover later.
  console.warn(
    "[security] SPECBOARDS_WEBHOOK_ALLOW_PRIVATE is set: webhook targets are " +
      "NOT checked for private/loopback addresses and connections are not " +
      "pinned. Intended for self-host on a trusted network only.",
  );
}

/**
 * Validate a webhook target URL and resolve it to the address(es) a delivery
 * may connect to, under the webhook policy. See {@link resolveTarget}.
 */
export async function resolveValidatedTarget(raw: string): Promise<TargetResolution> {
  const result = await resolveTarget(raw, {
    allowPrivate: allowPrivateWebhookTargets(),
  });
  // The shared resolver phrases the scheme error generically; webhooks have
  // always said "Webhook URLs must use https." and that text is asserted in
  // tests and shown to users on save.
  if (!result.ok && result.reason === "The URL must use https.") {
    return { ok: false, reason: "Webhook URLs must use https." };
  }
  return result;
}

/**
 * Validate a webhook target URL (HTTPS + not private/reserved). Thin wrapper
 * over {@link resolveValidatedTarget} for callers that only need a yes/no at
 * save time (see webhooks-service). The delivery path uses the resolved
 * addresses directly to pin the connection.
 */
export async function assertPublicUrl(raw: string): Promise<UrlCheck> {
  const result = await resolveValidatedTarget(raw);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
