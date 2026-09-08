import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { isBlockedIp, type UrlCheck } from "@/lib/egress";
import { isMultiTenant } from "@/lib/tenancy";

/**
 * The mail half of the egress guard.
 *
 * Same shape as the model half in `lib/ai/egress.ts`, and resolved the same
 * way: by deployment rather than by argument. A customer-supplied SMTP host is
 * an outbound connection to an address the customer chose, which is the tension
 * the model work already had to settle.
 *
 *   - Hosted (multi-tenant): a stored SMTP host is never reachable, and in fact
 *     never readable. `resolveMailConfig` refuses to read the settings row at
 *     all on a multi-tenant deployment, so mail there is whatever the operator
 *     put in env. This function stays the backstop for that.
 *   - Self-hosted (single-tenant): private targets are allowed. Reaching a
 *     relay at 10.0.0.25 is not a loophole, it is the entire feature.
 *
 * ── The one place this differs from the model policy, and why ───────────────
 * The model path needs `SPECBOARDS_MODEL_ALLOW_PRIVATE=1` before it will reach
 * a private address even on self-host. This one needs no flag, and the
 * difference is in who can write the value rather than in how much we trust it.
 * A model base URL is supplied by a tenant on every deployment, so self-host
 * still wants an explicit opt-in. An SMTP host can only be written by the
 * deployment operator, through a surface that does not exist on multi-tenant.
 *
 * Requiring a flag as well would also defeat the card's own acceptance
 * criteria: an env var is a redeploy, and the requirement is that an admin can
 * configure mail from Settings without one.
 */

/** Whether this deployment may send through a private/reserved SMTP host. */
function allowPrivateMailTargets(): boolean {
  return !isMultiTenant();
}

/**
 * Validate an SMTP host under the mail policy.
 *
 * Not built on `resolveTarget`, which speaks URLs and insists on https: an
 * SMTP endpoint is a host and a port, and its security is negotiated by the
 * protocol rather than named by a scheme. The classification underneath
 * (`isBlockedIp`) is shared, so the two guards agree on what "private" means
 * even though they disagree about whether to allow it.
 *
 * No connection pinning here, unlike the webhook and model paths. Pinning
 * exists to close a DNS-rebinding gap between check and connect, and it needs
 * a dispatcher to hand the resolved address to. nodemailer takes a host, not a
 * socket factory we can pin, and the deployments where this runs are the ones
 * where private addresses are permitted anyway, so there is nothing a rebind
 * could reach that the policy was not already going to allow.
 */
export async function assertReachableSmtpHost(host: string): Promise<UrlCheck> {
  const trimmed = host.trim();
  if (!trimmed) return { ok: false, reason: "Enter a host name." };
  if (allowPrivateMailTargets()) return { ok: true };

  const literal = isIP(trimmed);
  if (literal) {
    return isBlockedIp(trimmed)
      ? { ok: false, reason: "That host is a private or reserved address." }
      : { ok: true };
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(trimmed, { all: true });
  } catch {
    return { ok: false, reason: "Could not resolve that host." };
  }
  if (addrs.length === 0) return { ok: false, reason: "That host did not resolve." };
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      return {
        ok: false,
        reason: "That host resolves to a private or reserved address.",
      };
    }
  }
  return { ok: true };
}
