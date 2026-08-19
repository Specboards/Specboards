import { readJsonBody } from "@/lib/api/body";
import { authorizeModelProviderAdmin } from "../guard";
import { getDb } from "@/lib/db";
import { listWorkspaceModels } from "@/lib/model-provider-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/model-provider/models - ask an endpoint which models it serves,
 * so the settings screen offers a list instead of a text field. Admin-only.
 *
 * A POST for what is plainly a read, because the body can carry a key that has
 * not been saved yet: the picker has to work while someone is still filling in
 * the connect form, and a credential does not belong in a query string, an
 * access log or a browser history entry.
 *
 * Which key actually gets sent where is decided in the service, not here. See
 * `listWorkspaceModels`: the stored credential only ever goes to the endpoint
 * it was stored for.
 */

const NO_DB = Response.json(
  {
    error:
      "A model connection requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

export async function POST(req: Request) {
  const authz = await authorizeModelProviderAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  const outcome = await listWorkspaceModels(db, authz.scope.workspaceId, {
    ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
    ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
  });

  if (outcome.ok) return Response.json({ ok: true, models: outcome.models });

  if (outcome.error.kind === "not_configured") {
    return Response.json(
      { ok: false, kind: "not_configured", error: outcome.error.message },
      { status: 409 },
    );
  }

  // 200 with ok:false, for the same reason the test route does it: the request
  // to us succeeded, and it is the customer's endpoint that could not answer.
  // An endpoint with no listing route is the ordinary case, not an error.
  return Response.json({
    ok: false,
    kind: outcome.error.kind,
    error: outcome.error.message,
  });
}
