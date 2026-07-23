import { readJsonBody } from "@/lib/api/body";
import { getSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { recordMcpWorkspaceBinding } from "@/lib/mcp/workspace-binding";
import { getMembershipFor } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp/workspace-binding — record the workspace a user picked for an
 * MCP OAuth client on the consent screen. The `/api/mcp` resolver reads this
 * when a request carries no explicit `x-org-slug`, so a multi-org user never has
 * to configure a header. Authenticated by the browser session (the consent
 * screen posts this before approving); we re-validate that the caller is a
 * member of the workspace so a forged body can't bind an org they can't reach.
 */
export async function POST(req: Request) {
  const db = getDb();
  const user = await getSessionUser(req);
  if (!db || !user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { clientId?: unknown; workspaceId?: unknown };

  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!clientId || !workspaceId) {
    return Response.json(
      { error: "clientId and workspaceId are required." },
      { status: 400 },
    );
  }

  const membership = await getMembershipFor(db, user.id, workspaceId);
  if (!membership) {
    return Response.json(
      { error: "You do not have access to that workspace." },
      { status: 403 },
    );
  }

  await recordMcpWorkspaceBinding(db, {
    userId: user.id,
    clientId,
    workspaceId,
  });
  return Response.json({ ok: true });
}
