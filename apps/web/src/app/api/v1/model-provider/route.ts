import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  deleteModelProvider,
  getModelProvider,
  ModelProviderInputError,
  saveModelProvider,
} from "@/lib/model-provider-service";

export const dynamic = "force-dynamic";

/**
 * The workspace's model connection. Singular by design: the schema allows one
 * per workspace, so this is `/model-provider` rather than a collection, and
 * PUT upserts instead of the caller choosing between POST and PATCH.
 *
 * Admin-only throughout, including GET. The row itself holds no secret, but it
 * names the endpoint a workspace's inference goes to, and configuring it spends
 * the customer's money. RLS lets members read the row so an assistant request
 * can resolve it server-side; that is not the same as publishing it on an API.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error:
      "A model connection requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/** GET /api/v1/model-provider - the connection, or null. Admin-only. */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const provider = await getModelProvider(db, authz.scope.workspaceId);
  return Response.json({ provider });
}

/** PUT /api/v1/model-provider - create or replace it. Admin-only. */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  try {
    const provider = await saveModelProvider(db, authz.scope.workspaceId, {
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
      model: typeof body.model === "string" ? body.model : "",
      // Tri-state on purpose: absent keeps the stored key (so editing the model
      // name does not silently clear it), null removes it, a string replaces it.
      ...("apiKey" in body
        ? { apiKey: typeof body.apiKey === "string" ? body.apiKey : null }
        : {}),
    });
    return Response.json({ provider });
  } catch (err) {
    if (err instanceof ModelProviderInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/model-provider - disconnect and destroy the key. Admin-only. */
export async function DELETE(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const removed = await deleteModelProvider(db, authz.scope.workspaceId);
  if (!removed) {
    return Response.json({ error: "No model connection to remove." }, { status: 404 });
  }
  return Response.json({ ok: true });
}
