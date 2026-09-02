import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { createGoal, listGoals, parseGoalInput } from "@/lib/goals-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { GoalError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/goals — the workspace's goals with their key results, ordered
 * open first then by soonest period end.
 *
 * Each goal carries two progress figures, both computed on read and never
 * stored: `progress` is the mean of its key results (the outcome), and
 * `deliveryProgress` is the share of linked work that is done (the output).
 * They are separate on purpose: everything shipping while no metric moves is
 * exactly what goals exist to make visible.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  let page;
  try {
    page = parsePageRequest(new URL(req.url));
  } catch (err) {
    if (err instanceof InvalidPageError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const goals = await listGoals(authz.scope ?? undefined);
  if (page.limit === null) return Response.json({ goals });

  const { items, nextCursor } = paginate(goals, (g) => g.id, page);
  return Response.json({ goals: items, nextCursor });
}

/**
 * POST /api/v1/goals — create a goal. Body: { title, description?, productId?,
 * periodStart?, periodEnd?, parentGoalId?, status? }. Per-product
 * authorization is enforced by the store: admin/contributor for a product
 * goal, owner for an org-wide (null-product) one.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const goal = await createGoal(
      parseGoalInput(parsed.body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ goal }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
