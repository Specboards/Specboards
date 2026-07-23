import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
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

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const view = await createSavedView(
      parseSavedViewInput(body),
      authz.scope ?? undefined,
    );
    revalidatePath("/[org]/[product]/backlog", "page");
    return Response.json({ view }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidViewError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
