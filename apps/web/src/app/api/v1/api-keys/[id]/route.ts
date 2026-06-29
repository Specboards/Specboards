import { revokeApiKey } from "@/lib/api-keys";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/api-keys/[id] — revoke one of the signed-in user's keys. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "API keys require the database-backed deployment." },
      { status: 501 },
    );
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const { id } = await params;
  const revoked = await revokeApiKey(db, session.user.id, id);
  if (!revoked) {
    return Response.json({ error: "Key not found." }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
