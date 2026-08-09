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
 * 4. Start the in-process webhook outbox drainer. No-op in local file mode,
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

    const { startDrainer } = await import("@/lib/webhooks/drainer");
    startDrainer();
  }
}
