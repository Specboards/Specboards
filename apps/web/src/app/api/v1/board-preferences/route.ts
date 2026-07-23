import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidBoardPreferencesError,
  getBoardPreferences,
  parseBoard,
  parseBoardPreferences,
  setBoardPreferences,
} from "@/lib/board-preferences-service";
import type { BoardKey } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The page path whose cards a given board's prefs drive (for revalidation). */
const BOARD_PATHS: Record<BoardKey, string> = {
  backlog: "/[org]/[product]/backlog",
  roadmap: "/[org]/[product]/roadmap",
};

/** Which space the request targets, from `?board=` (defaults to backlog). */
function boardFromRequest(req: Request) {
  return parseBoard(new URL(req.url).searchParams.get("board"));
}

/** GET /api/v1/board-preferences — the acting user's board display prefs. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const preferences = await getBoardPreferences(
    authz.scope ?? undefined,
    boardFromRequest(req),
  );
  return Response.json({ preferences });
}

/** PUT /api/v1/board-preferences — replace the acting user's board prefs. */
export async function PUT(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const board = boardFromRequest(req);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    await setBoardPreferences(
      parseBoardPreferences(body),
      authz.scope ?? undefined,
      board,
    );
    revalidatePath(BOARD_PATHS[board], "page");
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidBoardPreferencesError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
