import { resolveTarget, type TargetResolution, type UrlCheck } from "@/lib/egress";
import { isMultiTenant } from "@/lib/tenancy";

/**
 * The model half of the egress guard. Classification and pinning are shared
 * with webhooks in `@/lib/egress`; what lives here is the policy, because the
 * two features genuinely disagree about private addresses.
 *
 * ── The tension this resolves ───────────────────────────────────────────────
 * The guard exists to stop a customer-supplied URL reaching something it should
 * not. The on-prem requirement is that it reach a private address inside the
 * customer's own network, which is the same thing described approvingly. Both
 * are real, so the resolution is by deployment rather than by argument:
 *
 *   - Hosted (multi-tenant): private targets are never reachable. A tenant
 *     supplies the base URL, the app sits in a network with a metadata endpoint
 *     and internal services, and no amount of configuration should let one
 *     tenant aim the server at them. The flag is ignored, not merely defaulted
 *     off, exactly as `allowPrivateWebhookTargets` does.
 *   - Self-hosted (single-tenant): `SPECBOARDS_MODEL_ALLOW_PRIVATE=1` opts in.
 *     The operator, the tenant and the network owner are the same party, so
 *     "reach my vLLM box at 10.0.0.4" is a coherent thing for them to ask for.
 *
 * ── What this costs us ──────────────────────────────────────────────────────
 * Both `specboard` and `specboard-test` run multi-tenant, so the self-hosted
 * path CANNOT be exercised on our own test deployment: any private endpoint is
 * refused there by design. It is covered locally and by the integration tests
 * in `model-egress.int.test.ts` instead. That is a deliberate trade, and worth
 * knowing before someone reads a refusal on test as a bug.
 *
 * A separate flag from the webhook one rather than a shared "allow private"
 * switch: enabling a self-hosted model must not silently re-point webhook
 * deliveries at the internal network too.
 */

/** Whether this deployment may reach a private/reserved model endpoint. */
export function allowPrivateModelTargets(): boolean {
  if (isMultiTenant()) return false;
  return process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE === "1";
}

/**
 * Boot guard, called from `instrumentation.ts` beside the RLS, origin and
 * webhook-egress guards. Fails the release when a hosted deployment sets the
 * escape hatch, so the misconfiguration surfaces at deploy time rather than
 * being silently ignored on every request.
 */
export function assertModelEgressPolicy(): void {
  if (process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE !== "1") return;

  if (isMultiTenant()) {
    throw new Error(
      "[security] Refusing to start: SPECBOARDS_MODEL_ALLOW_PRIVATE is set on " +
        "a multi-tenant deployment. That flag lets a model endpoint point at " +
        "private and loopback addresses, and tenants supply their own base " +
        "URLs, so it would hand any tenant a request forgery primitive against " +
        "the internal network. Unset it.",
    );
  }
  console.warn(
    "[security] SPECBOARDS_MODEL_ALLOW_PRIVATE is set: model endpoints may " +
      "point at private/loopback addresses and connections are not pinned. " +
      "Intended for self-host reaching inference on its own network.",
  );
}

/**
 * Validate a model base URL and resolve the address(es) a call may connect to,
 * under the model policy.
 *
 * Called on save *and* again before every completion. Re-checking matters: a
 * row written while a deployment allowed private targets must stop working the
 * moment that policy is tightened, and a hostname that resolved publicly at
 * save time can resolve somewhere private later.
 */
export async function resolveModelTarget(raw: string): Promise<TargetResolution> {
  const result = await resolveTarget(raw, {
    allowPrivate: allowPrivateModelTargets(),
  });
  if (!result.ok && result.reason === "The URL must use https.") {
    return {
      ok: false,
      reason:
        "The model endpoint must use https. Plain http is only available to a " +
        "self-hosted deployment with SPECBOARDS_MODEL_ALLOW_PRIVATE set.",
    };
  }
  return result;
}

/** Yes/no form for save-time validation, mirroring `assertPublicUrl`. */
export async function assertReachableModelUrl(raw: string): Promise<UrlCheck> {
  const result = await resolveModelTarget(raw);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
