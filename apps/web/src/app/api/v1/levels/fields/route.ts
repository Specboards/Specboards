import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import {
  InvalidPatchError,
  parseLevelFieldsUpdate,
  updateLevelFields,
} from "@/lib/features-service";
import { LevelError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * PUT /api/v1/levels/fields — set which metadata fields are available per
 * hierarchy level (Settings → Cards). Body: { fields: { [levelKey]:
 * string[] | null } }; null = every field. Admin-only, like PUT /api/v1/levels;
 * local file mode is ungated.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const scope = authz.scope ?? undefined;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

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
