/**
 * Next.js runs this once when the server process boots (Node runtime only;
 * both jobs below use Node APIs that don't belong in the edge runtime).
 *
 * 1. Tenant-isolation guard: verify the tenant-data connection is one RLS
 *    actually constrains, and refuse to start a multi-tenant deployment
 *    otherwise (fail closed at deploy time; see lib/rls-guard.ts).
 * 2. Start the in-process webhook outbox drainer. No-op in local file mode,
 *    where `startDrainer` finds no database.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertTenantIsolation } = await import("@/lib/rls-guard");
    await assertTenantIsolation();

    const { startDrainer } = await import("@/lib/webhooks/drainer");
    startDrainer();
  }
}
