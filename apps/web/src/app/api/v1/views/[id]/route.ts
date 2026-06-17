import { revalidatePath } from "next/cache";

import { authorizeWrite } from "@/lib/auth-session";
import { deleteSavedView } from "@/lib/views-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/v1/views/:id — remove one of the acting user's saved views. */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  await deleteSavedView(id, authz.scope ?? undefined);
  revalidatePath("/backlog");
  return new Response(null, { status: 204 });
}
