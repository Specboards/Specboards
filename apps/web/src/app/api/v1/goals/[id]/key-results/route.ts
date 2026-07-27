import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createKeyResult,
  parseKeyResultInput,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { GoalError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/goals/:id/key-results — add a key result. Body: { title,
 * targetValue, metricKind?, startValue?, currentValue? }. Returns the whole
 * goal, since adding a key result changes its computed progress.
 *
 * `targetValue` must differ from `startValue` (except for a boolean metric):
 * progress is measured as distance travelled from start to target, so an
 * identical pair has no distance to be a fraction of.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const goal = await createKeyResult(
      id,
      parseKeyResultInput(parsed.body),
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
