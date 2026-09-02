import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  deleteCycle,
  parseCyclePatch,
  updateCycle,
} from "@/lib/cycles-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { CycleError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/cycles/:id — update a cycle's name, product, dates, or notes.
 * There is no status to set: a cycle's state follows its dates. Per-product
 * authorization enforced by the store.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const cycle = await updateCycle(
      id,
      parseCyclePatch(parsed.body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ cycle });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof CycleError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * DELETE /api/v1/cycles/:id — remove a cycle. Its items are unscheduled (their
 * cycle cleared), not deleted, and their release assignment is untouched.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteCycle(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof CycleError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
