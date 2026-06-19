import { revalidatePath } from "next/cache";

import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createWorkItem,
  parseCreateFeatureInput,
} from "@/lib/features-service";
import { getStore } from "@/lib/store";
import { FeatureError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/features — list features in the caller's workspace. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const store = await getStore();
  const features = await store.listFeatures(authz.scope ?? undefined);
  return Response.json({ features });
}

/**
 * POST /api/v1/features — create a DB-native work item (initiative/epic). The
 * leaf level comes from spec sync, not this endpoint; the store rejects a leaf
 * level or an invalid parent.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const feature = await createWorkItem(
      parseCreateFeatureInput(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"]) revalidatePath(path, "page");
    return Response.json({ feature }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof FeatureError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
