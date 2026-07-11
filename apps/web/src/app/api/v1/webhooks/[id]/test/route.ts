import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";
import { sendTestEvent } from "@/lib/webhooks-service";

export const dynamic = "force-dynamic";

const NO_DB = Response.json(
  { error: "Webhooks require a database (unavailable in local file mode)." },
  { status: 501 },
);

/**
 * POST /api/v1/webhooks/:id/test — send a signed test delivery now and report
 * the endpoint's response synchronously. Admin-only. Bypasses the outbox so the
 * admin gets immediate pass/fail feedback while wiring up a consumer.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const limited = await enforceQuota(db, QUOTAS.webhookTest, authz.scope.workspaceId);
  if (limited) return limited;

  const { id } = await params;

  const result = await sendTestEvent(db, authz.scope.workspaceId, id);
  if (result === null) {
    return Response.json({ error: "Endpoint not found." }, { status: 404 });
  }
  if (result.ok) {
    return Response.json({ ok: true, statusCode: result.statusCode });
  }
  return Response.json(
    { ok: false, statusCode: result.statusCode, error: result.error },
    { status: 502 },
  );
}
