import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import {
  InvalidPatchError,
  deleteProperty,
  parsePropertyPatch,
  updateProperty,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { PropertyError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/v1/properties/:id — update a custom property's label, options,
 * level availability, or position (its type and key are fixed). Admin-only.
 */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const property = await updateProperty(
      id,
      parsePropertyPatch(body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ property });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof PropertyError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * DELETE /api/v1/properties/:id — remove a custom property definition.
 * Stored item values are left in place (invisible without a definition).
 * Admin-only.
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  try {
    await deleteProperty(id, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof PropertyError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
