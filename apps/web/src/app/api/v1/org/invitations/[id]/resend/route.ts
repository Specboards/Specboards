import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { InvitationError, resendInvitation } from "@/lib/invitations-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const FILE_MODE = Response.json(
  { error: "Invitations are unavailable in local file mode." },
  { status: 400 },
);

/** POST /api/v1/org/invitations/:id/resend — regenerate token and re-send. */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;
  const { id } = await params;

  try {
    await resendInvitation(db, authz.scope.workspaceId, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof InvitationError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
