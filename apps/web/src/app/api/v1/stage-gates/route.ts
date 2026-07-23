import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  listStageGates,
  parseStageGates,
  replaceStageGates,
} from "@/lib/features-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/stage-gates - the workspace's stage gates ([] = none defined). */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const gates = await listStageGates(authz.scope ?? undefined);
  return Response.json({ gates });
}

/**
 * PUT /api/v1/stage-gates - replace the workspace's stage gates. Admin-only
 * (gates block every member's transitions and a full replace resets per-item
 * checklist progress); local file mode is ungated.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const scope = authz.scope ?? undefined;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const gates = await replaceStageGates(parseStageGates(body), scope);
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/settings/work-cards",
    ])
      revalidatePath(path, "page");
    return Response.json({ gates });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
