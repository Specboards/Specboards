import { revalidatePath } from "next/cache";

import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidViewError,
  createSavedView,
  listSavedViews,
  parseSavedViewInput,
} from "@/lib/views-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/views — the acting user's saved backlog views. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const views = await listSavedViews(authz.scope ?? undefined);
  return Response.json({ views });
}

/** POST /api/v1/views — save the current filter bundle as a named view. */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const view = await createSavedView(
      parseSavedViewInput(body),
      authz.scope ?? undefined,
    );
    revalidatePath("/backlog");
    return Response.json({ view }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidViewError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
