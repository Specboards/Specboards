import { revalidatePath } from "next/cache";

import { getSessionUser, resolveReadScope } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  InvalidPatchError,
  listStatuses,
  parseStatusStages,
  replaceStatuses,
} from "@/lib/features-service";
import { getMembership } from "@/lib/workspace";
import type { WorkspaceScope } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/statuses — the workspace's workflow stages ([] = built-in default). */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const statuses = await listStatuses(authz.scope ?? undefined);
  return Response.json({ statuses });
}

/**
 * PUT /api/v1/statuses — replace the workspace's workflow stages. Admin-only
 * (it reshapes every member's board and re-homes orphaned items); local file
 * mode is ungated.
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
        { error: "Only the owner can change the workflow." },
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
