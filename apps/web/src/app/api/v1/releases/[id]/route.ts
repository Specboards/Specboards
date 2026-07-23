import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidPatchError,
  deleteRelease,
  parseReleasePatch,
  updateRelease,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { ReleaseError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/v1/releases/:id — update a release's metadata (name, product,
 * status, dates, notes). Per-product authorization enforced by the store
 * (admin/contributor for a product release, owner for a portfolio release). */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const release = await updateRelease(
      id,
      parseReleasePatch(body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ release });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof ReleaseError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * DELETE /api/v1/releases/:id — remove a release. Its items are unscheduled
 * (release cleared), not deleted. Per-product authorization enforced by the
 * store (admin/contributor for a product release, owner for a portfolio one).
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteRelease(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ReleaseError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
