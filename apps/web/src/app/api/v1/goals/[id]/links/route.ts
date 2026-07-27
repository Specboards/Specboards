import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  linkGoal,
  listGoalContributions,
  unlinkGoal,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { GoalError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The work items laddering up to this goal that the caller can read. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const contributions = await listGoalContributions(id, authz.scope ?? undefined);
  return Response.json({ contributions });
}

/**
 * POST /api/v1/goals/:id/links — link a work item to this goal. Body:
 * { specId }. Many-to-many and reachable from any hierarchy level, so an
 * initiative and a single work item can both contribute, and the item may
 * belong to a different product than the goal: cross-product linkage is the
 * point of the join table, not an accident to be guarded against.
 *
 * Linking something already linked succeeds rather than erroring: the caller's
 * intent is already true.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const body = parsed.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InvalidPatchError("Request body must be a JSON object.");
    }
    const specId = (body as Record<string, unknown>).specId;
    if (typeof specId !== "string" || !specId) {
      throw new InvalidPatchError("specId is required.");
    }
    await linkGoal(id, specId, authz.scope ?? undefined);
    revalidateCardPages();
    const contributions = await listGoalContributions(
      id,
      authz.scope ?? undefined,
    );
    return Response.json({ contributions }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/goals/:id/links?specId=… — unlink a work item. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const specId = new URL(req.url).searchParams.get("specId");
  if (!specId) {
    return Response.json({ error: "specId is required." }, { status: 422 });
  }
  try {
    await unlinkGoal(id, specId, authz.scope ?? undefined);
    revalidateCardPages();
    const contributions = await listGoalContributions(
      id,
      authz.scope ?? undefined,
    );
    return Response.json({ contributions });
  } catch (err) {
    if (err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
