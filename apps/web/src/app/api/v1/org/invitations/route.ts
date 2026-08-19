import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, authorizeOrgAdminBrowserOnly } from "@/lib/auth-session";
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

/**
 * POST /api/v1/org/invitations — invite an email with a role. Org-admin only,
 * and from a browser session only.
 *
 * An invitation is a route to a real session, so this belongs with the other
 * actions a leaked credential must not be able to perform: minting a key,
 * creating a service account, configuring the model connection. A holder of a
 * leaked owner key could otherwise invite an address they control as an owner,
 * redeem the emailed token, and hold a session that revoking the key does not
 * take away.
 *
 * GET stays reachable with a key. Listing invitations discloses who has been
 * invited, which is worth knowing about, but it confers no authority and is not
 * what this guard is for.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(
    req,
    "Invitations are sent from a signed-in browser session, never with an API key.",
  );
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

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
