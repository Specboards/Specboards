import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  createInvitation,
  InvitationError,
  listInvitations,
  parseInvitationInput,
} from "@/lib/invitations-service";

export const dynamic = "force-dynamic";

const FILE_MODE = Response.json(
  { error: "Invitations are unavailable in local file mode." },
  { status: 400 },
);

/** GET /api/v1/org/invitations — the org's invitations. Org-admin only. */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  const list = await listInvitations(db, authz.scope.workspaceId);
  return Response.json({ invitations: list });
}

/** POST /api/v1/org/invitations — invite an email with a role. Org-admin only. */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const invitation = await createInvitation(
      db,
      authz.scope.workspaceId,
      authz.scope.userId,
      parseInvitationInput(body),
    );
    return Response.json({ invitation }, { status: 201 });
  } catch (err) {
    if (err instanceof InvitationError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
