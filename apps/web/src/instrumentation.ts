/**
 * Next.js runs this once when the server process boots (Node runtime only;
 * both jobs below use Node APIs that don't belong in the edge runtime).
 *
 * 1. Local-mode guard: refuse to start unauthenticated (no database) unless
 *    that was explicitly asked for and is reachable only from this machine
 *    (see lib/local-mode.ts). First, because the checks below assume the
 *    deployment knows which of the two shapes it is.
 * 2. Tenant-isolation guard: verify the tenant-data connection is one RLS
 *    actually constrains, and refuse to start a multi-tenant deployment
 *    otherwise (fail closed at deploy time; see lib/rls-guard.ts).
 * 3. Webhook egress policy: refuse a hosted deployment that has the SSRF
 *    escape hatch set (see lib/webhooks/ssrf.ts).
 * 4. Model egress policy: the same refusal for the model endpoint's own escape
 *    hatch (see lib/ai/egress.ts). A separate flag and a separate guard, so
 *    allowing a self-hosted model cannot silently re-point webhooks at the
 *    internal network as well.
 * 5. Model TLS: if a private certificate authority is configured for the model
 *    endpoint, read it now (see lib/ai/tls.ts). A mistyped path should stop the
 *    release rather than surface as an unreachable endpoint on someone's first
 *    call.
 * 6. Start the in-process webhook outbox drainer. No-op in local file mode,
 *    where `startDrainer` finds no database.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertLocalMode } = await import("@/lib/local-mode");
    assertLocalMode();

    const { assertTenantIsolation, assertWorkerIsolation } = await import("@/lib/rls-guard");
    await assertTenantIsolation();
    await assertWorkerIsolation();

    const { assertCanonicalOrigin } = await import("@/lib/origin-guard");
    assertCanonicalOrigin();

    const { assertWebhookEgressPolicy } = await import("@/lib/webhooks/ssrf");
    assertWebhookEgressPolicy();

    const { assertModelEgressPolicy } = await import("@/lib/ai/egress");
    assertModelEgressPolicy();

    const { assertModelTlsConfig } = await import("@/lib/ai/tls");
    assertModelTlsConfig();

    const { startDrainer } = await import("@/lib/webhooks/drainer");
    startDrainer();
  }
}
