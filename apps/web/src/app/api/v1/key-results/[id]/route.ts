import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidPatchError,
  deleteKeyResult,
  parseKeyResultPatch,
  updateKeyResult,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { GoalError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/key-results/:id — update a key result, most often its
 * `currentValue` as someone checks in on the metric. Returns the whole goal,
 * because its progress is the mean of its key results and has just changed.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const goal = await updateKeyResult(
      id,
      parseKeyResultPatch(parsed.body),
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

/** DELETE /api/v1/key-results/:id — remove a key result; returns its goal. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    const goal = await deleteKeyResult(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ goal });
  } catch (err) {
    if (err instanceof GoalError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
