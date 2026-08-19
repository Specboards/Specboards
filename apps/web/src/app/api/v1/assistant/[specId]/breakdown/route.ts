import { authorizeWrite } from "@/lib/auth-session";
import { AssistantItemError } from "@/lib/assistant-service";
import {
  BreakdownForbiddenError,
  BreakdownLevelError,
  estimateBreakdown,
  proposeBreakdown,
} from "@/lib/breakdown-service";
import { getDb } from "@/lib/db";
import { enforceQuota, QUOTAS } from "@/lib/rate-limit";

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

/**
 * GET /api/v1/assistant/:specId/breakdown - roughly what the POST would send,
 * in tokens. Spends nothing.
 *
 * A GET on the same path as the operation it describes, rather than a
 * `?estimate=1` on the POST or a resource of its own: the thing being estimated
 * is precisely this endpoint's request, and keeping them on one path is what
 * stops the estimate quietly describing a payload the POST no longer builds.
 * Same authorization, because the estimate is derived from the item's content
 * and its size is a fact about that content.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  const { specId } = await params;
  try {
    const estimate = await estimateBreakdown(db, authz.scope, specId);
    // Null means there is no level below this one, so there is nothing to
    // estimate. Not an error: the caller is a button deciding what to show.
    return Response.json(estimate ?? { estimatedPromptTokens: null });
  } catch (err) {
    if (err instanceof AssistantItemError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db || !authz.scope) return NO_DB;

  // Bounds the RATE; the workspace spend cap bounds the total. The cap is
  // checked without a transaction, so concurrent calls can each pass it;
  // throttling a breakdown is what keeps that overshoot to roughly one
  // window rather than to however many requests arrive at once. Keyed per
  // user so one runaway script cannot starve a colleague.
  const limited = await enforceQuota(db, QUOTAS.breakdown, authz.scope.userId);
  if (limited) return limited;

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
