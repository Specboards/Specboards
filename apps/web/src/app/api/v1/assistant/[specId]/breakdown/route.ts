import { authorizeWrite } from "@/lib/auth-session";
import { AssistantItemError } from "@/lib/assistant-service";
import {
  BreakdownForbiddenError,
  BreakdownLevelError,
  proposeBreakdown,
} from "@/lib/breakdown-service";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * POST /api/v1/assistant/:specId/breakdown - ask the model to propose the level
 * below this item. Creates nothing.
 *
 * ── Why this is under `assistant` and accepting is not ──────────────────────
 * Scopes come from the first path segment. This one spends the workspace's
 * money at their model provider and changes nothing, so it belongs to
 * `assistant:write` alongside asking a question. *Creating* the children the
 * reviewer ticked is an ordinary `POST /features`, needing `features:write`,
 * which is the same split the spec-edit proposals use and for the same reason:
 * a key that can make the assistant suggest work should not thereby be able to
 * fill somebody's backlog with it.
 *
 * A POST rather than a GET despite reading nothing, because it is not free and
 * it is not idempotent in any sense a cache should believe: each call bills the
 * customer and returns a different list.
 */
const NO_DB = Response.json(
  { error: "The assistant requires a database (unavailable in local file mode)." },
  { status: 501 },
);

export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  try {
    const outcome = await proposeBreakdown(db, authz.scope, specId);
    // A model failure is a 200 with an error in it, matching the panel: the
    // request to Specboards succeeded, and what failed is a third party the
    // customer configured. `kind` is what decides whether the right thing to
    // say is "connect a model" or "check your key".
    return Response.json(outcome);
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof BreakdownForbiddenError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof BreakdownLevelError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
