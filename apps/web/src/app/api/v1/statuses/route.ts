import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeOrgAdmin, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  listStatuses,
  parseStatusStages,
  replaceStatuses,
} from "@/lib/features-service";
import { resolveWorkflowFor } from "@/lib/repo-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statuses — the workspace's workflow stages ([] = built-in
 * default) plus the fully-resolved `workflow` (ordered statuses + legal
 * transitions) the PATCH validator enforces. The resolved graph lets API
 * clients (e.g. the CLI's `status --advance`) compute a legal multi-step path
 * without reimplementing the default/config.yml/admin-stage precedence.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const scope = authz.scope ?? undefined;
  const [statuses, workflow] = await Promise.all([
    listStatuses(scope),
    resolveWorkflowFor(authz.scope ?? null),
  ]);
  return Response.json({
    statuses,
    workflow: {
      statuses: workflow.statuses,
      transitions: workflow.transitions,
    },
  });
}

/**
 * PUT /api/v1/statuses — replace the workspace's workflow stages. Admin-only
 * (it reshapes every member's board and re-homes orphaned items); local file
 * mode is ungated.
 */
export async function PUT(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const scope = authz.scope ?? undefined;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const statuses = await replaceStatuses(parseStatusStages(body), scope);
    for (const path of [
      "/[org]/[product]/backlog",
      "/[org]/[product]/roadmap",
      "/[org]/settings/work-cards",
    ])
      revalidatePath(path, "page");
    return Response.json({ statuses });
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
