import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  deleteWebhookEndpoint,
  updateWebhookEndpoint,
  WebhookInputError,
} from "@/lib/webhooks-service";

export const dynamic = "force-dynamic";

const NO_DB = Response.json(
  { error: "Webhooks require a database (unavailable in local file mode)." },
  { status: 501 },
);

/** PATCH /api/v1/webhooks/:id — toggle active / edit events, url, product. Admin-only. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;
  const { id } = await params;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const endpoint = await updateWebhookEndpoint(
      db,
      authz.scope.workspaceId,
      id,
      body,
    );
    if (!endpoint) {
      return Response.json({ error: "Endpoint not found." }, { status: 404 });
    }
    return Response.json({ endpoint });
  } catch (err) {
    if (err instanceof WebhookInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/webhooks/:id — remove an endpoint (and its deliveries). Admin-only. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;
  const { id } = await params;

  const removed = await deleteWebhookEndpoint(db, authz.scope.workspaceId, id);
  if (!removed)
    return Response.json({ error: "Endpoint not found." }, { status: 404 });
  return new Response(null, { status: 204 });
}
