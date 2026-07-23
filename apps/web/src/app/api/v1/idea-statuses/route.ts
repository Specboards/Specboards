import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  listIdeaStatuses,
  parseStatusStages,
  replaceIdeaStatuses,
} from "@/lib/features-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/idea-statuses - the workspace's idea review stages ([] = default). */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const statuses = await listIdeaStatuses(authz.scope ?? undefined);
  return Response.json({ statuses });
}

/**
 * PUT /api/v1/idea-statuses - replace the workspace's idea review stages.
 * Admin-only (it reshapes triage for every member); local file mode is ungated.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const statuses = await replaceIdeaStatuses(
      parseStatusStages(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/ideas", "/[org]/settings/ideas"])
      revalidatePath(path, "page");
    return Response.json({ statuses });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
