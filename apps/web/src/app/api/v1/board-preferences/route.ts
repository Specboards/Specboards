import { revalidatePath } from "next/cache";

import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidBoardPreferencesError,
  getBoardPreferences,
  parseBoardPreferences,
  setBoardPreferences,
} from "@/lib/board-preferences-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/board-preferences — the acting user's board display prefs. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const preferences = await getBoardPreferences(authz.scope ?? undefined);
  return Response.json({ preferences });
}

/** PUT /api/v1/board-preferences — replace the acting user's board prefs. */
export async function PUT(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    await setBoardPreferences(
      parseBoardPreferences(body),
      authz.scope ?? undefined,
    );
    revalidatePath("/[org]/[product]/backlog", "page");
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidBoardPreferencesError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
