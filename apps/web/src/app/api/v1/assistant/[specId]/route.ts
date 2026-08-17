import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  AssistantInputError,
  AssistantItemError,
  getAssistantPanelData,
  sendAssistantMessage,
} from "@/lib/assistant-service";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * The assistant conversation about an item.
 *
 * ── Why this is `/assistant/{specId}` and not `/features/{specId}/assistant` ─
 * The nested URL is the tidier REST shape and it is the wrong one here. API key
 * scopes are derived from the first path segment under `/api/v1`
 * (`lib/api-scopes.ts`), so nesting this under features would mean any key
 * granted `features:write` - "let this integration edit our items" - could also
 * spend the customer's money at their model provider, without that ever having
 * been granted or even mentioned. As its own resource it needs an explicit
 * `assistant:write`, so the spend channel is something a person opted into.
 *
 * Gated at member level, not admin: configuring the connection is owner-only
 * because it picks the endpoint and holds the key, but *using* it is ordinary
 * product work. The rule is the same as commenting - anyone who can read the
 * item can ask about it - and the per-product visibility check that enforces
 * it lives in the service, which resolves the item before doing anything else.
 *
 * A completion is a write in every sense that matters here (it costs money at
 * the customer's provider and it appends to a persisted thread), so POST takes
 * the write path rather than the read one.
 */

/** Needs a database + running server; unavailable in local file mode. */
const NO_DB = Response.json(
  {
    error: "The assistant requires a database (unavailable in local file mode).",
  },
  { status: 501 },
);

/**
 * GET /api/v1/assistant/:specId - the thread, oldest first, plus what would be
 * sent about this item. `context` is returned alongside so the panel
 * can disclose it before anyone spends a token, rather than describing it from
 * a second source that can fall out of step.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  try {
    return Response.json(await getAssistantPanelData(db, authz.scope, specId));
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

/**
 * POST /api/v1/assistant/:specId - ask a question. Body: { message }.
 *
 * Returns 200 with `{ modelError: { kind, message } }` when the *model* refused
 * or could not be reached, rather than mapping it onto an HTTP status. The
 * request to Specboards succeeded; what failed is a call to a third party the
 * customer configured, and the panel needs `kind` to tell "connect a model
 * first" from "your key is wrong" from "that endpoint is unreachable".
 *
 * Under its own key rather than `error`, which is a string everywhere else on
 * this API. A client that reads `error` for a message would otherwise render
 * "[object Object]" at exactly the moment it has something useful to say.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as Record<string, unknown>;

  try {
    const outcome = await sendAssistantMessage(
      db,
      authz.scope,
      specId,
      typeof body.message === "string" ? body.message : "",
    );
    if (!outcome.ok) return Response.json({ modelError: outcome.error });
    return Response.json({ turns: outcome.turns }, { status: 201 });
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof AssistantInputError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
