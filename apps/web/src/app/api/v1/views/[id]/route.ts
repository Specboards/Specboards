import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidViewError,
  deleteSavedView,
  parseSavedViewPatch,
  updateSavedView,
} from "@/lib/views-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/v1/views/:id — rename or re-filter one of the acting user's saved views. */
export async function PATCH(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const { id } = await params;
  try {
    const view = await updateSavedView(
      id,
      parseSavedViewPatch(body),
      authz.scope ?? undefined,
    );
    if (!view) {
      return Response.json({ error: "Saved view not found." }, { status: 404 });
    }
    revalidatePath("/[org]/[product]/backlog", "page");
    return Response.json({ view });
  } catch (err) {
    if (err instanceof InvalidViewError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/** DELETE /api/v1/views/:id — remove one of the acting user's saved views. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  await deleteSavedView(id, authz.scope ?? undefined);
  revalidatePath("/[org]/[product]/backlog", "page");
  return new Response(null, { status: 204 });
}
