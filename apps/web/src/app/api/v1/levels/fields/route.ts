import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth-session";
import {
  InvalidPatchError,
  parseLevelFieldsUpdate,
  updateLevelFields,
} from "@/lib/features-service";
import { getDb } from "@/lib/db";
import { getMembership } from "@/lib/workspace";
import { LevelError, type WorkspaceScope } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/levels/fields — set which metadata fields are available per
 * hierarchy level (Settings → Cards). Body: { fields: { [levelKey]:
 * string[] | null } }; null = every field. Admin-only, like PUT /api/v1/levels;
 * local file mode is ungated.
 */
export async function PUT(req: Request) {
  const db = getDb();
  let scope: WorkspaceScope | undefined;
  if (db) {
    const user = await getSessionUser(req);
    if (!user) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const membership = await getMembership(db, user.id);
    if (!membership) {
      return Response.json(
        { error: "You do not belong to a workspace." },
        { status: 403 },
      );
    }
    if (membership.role !== "owner") {
      return Response.json(
        { error: "Only the owner can change card fields." },
        { status: 403 },
      );
    }
    scope = { userId: user.id, workspaceId: membership.workspaceId };
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const levels = await updateLevelFields(parseLevelFieldsUpdate(body), scope);
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/settings/work-cards",
    ])
      revalidatePath(path, "page");
    return Response.json({ levels });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof LevelError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
