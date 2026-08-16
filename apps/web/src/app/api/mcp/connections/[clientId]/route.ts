import { getBrowserSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { revokeMcpConnection } from "@/lib/mcp/workspace-binding";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/mcp/connections/:clientId - disconnect one of the caller's MCP
 * OAuth connections. Deletes its access tokens, its recorded consent and its
 * binding, so the agent stops on its next call and reconnecting asks the user
 * again rather than silently reusing the old answer.
 *
 * Scoped to the session user's own connections. An OAuth connection acts as a
 * person, so it is that person's to revoke; there is no id to confuse here,
 * because the delete is keyed by (their user id, clientId).
 *
 * Browser session only, deliberately: this is not under `/api/v1`, so an API
 * key must not reach it. A restricted key being able to sever its owner's other
 * connections is exactly the cross-credential reach `getBrowserSessionUser`
 * exists to prevent.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const db = getDb();
  const user = await getBrowserSessionUser(req);
  if (!db || !user) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const { clientId } = await params;
  const revoked = await revokeMcpConnection(db, user.id, decodeURIComponent(clientId));
  if (!revoked) {
    return Response.json({ error: "No such connection." }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
