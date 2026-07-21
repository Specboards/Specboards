import { revalidatePath } from "next/cache";

import { authorizeWrite } from "@/lib/auth-session";
import {
  InvalidPatchError,
  bulkPatchFeatures,
  parseBulkPatchRequest,
} from "@/lib/features-service";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/features/bulk — apply one patch (status / assignee / tags /
 * releaseId) to many items at once. Each item is validated and written on its
 * own, so an illegal move on one doesn't block the rest; the response reports a
 * per-item result. A malformed request (bad body, disallowed field) is a 422;
 * per-item failures come back 200 with `failCount > 0`.
 */
export async function PATCH(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const { specIds, patch, tagOps } = parseBulkPatchRequest(body);
    const result = await bulkPatchFeatures(
      specIds,
      patch,
      tagOps,
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) {
      revalidatePath(path, "page");
    }
    revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
    return Response.json(result);
  } catch (err) {
    if (err instanceof InvalidPatchError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
