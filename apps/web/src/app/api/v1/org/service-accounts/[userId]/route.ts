import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  ServiceAccountError,
  revokeServiceAccount,
} from "@/lib/service-accounts-service";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/org/service-accounts/:userId - revoke an agent. Owner-only.
 *
 * Kills the agent's keys and drops its workspace membership and product
 * grants, so it stops on its next call. Its `users` row survives, keeping the
 * agent's past edits attributed in item history.
 *
 * Unlike creation this is reachable with an API key: it only ever removes
 * access, so a leaked owner key cannot use it to escalate.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Service accounts are unavailable in local file mode." },
      { status: 400 },
    );
  }

  const { userId } = await params;
  try {
    await revokeServiceAccount(db, authz.scope.workspaceId, userId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof ServiceAccountError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
