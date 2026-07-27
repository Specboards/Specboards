import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  deleteGoal,
  listGoalContributions,
  listGoals,
  parseGoalPatch,
  updateGoal,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { GoalError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/goals/:id — one goal with its key results and the work
 * contributing to it. Contributions are filtered to items the caller can read;
 * the goal itself stays visible either way, since hiding an org-wide goal
 * because one contributor is out of reach would hide it from almost everyone.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const scope = authz.scope ?? undefined;
  const goal = (await listGoals(scope)).find((g) => g.id === id);
  if (!goal) return Response.json({ error: "Unknown goal." }, { status: 404 });
  const contributions = await listGoalContributions(id, scope);
  return Response.json({ goal, contributions });
}

/** PATCH /api/v1/goals/:id — update a goal's title, description, product,
 * period, parent, or status. */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const goal = await updateGoal(
      id,
      parseGoalPatch(parsed.body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ goal });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * DELETE /api/v1/goals/:id — remove a goal. Its key results go with it and its
 * links are cleared; the work items on the other end of those links are
 * untouched, and child goals are orphaned to the root rather than deleted.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteGoal(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
