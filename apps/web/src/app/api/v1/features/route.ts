import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createWorkItem,
  parseCreateFeatureInput,
} from "@/lib/features-service";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";
import { getStore } from "@/lib/store";
import { FeatureError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/features — list features in the caller's workspace. Returns the
 * full list by default; pass `?limit` (and echo `nextCursor` back as `?cursor`)
 * for opt-in pagination, which adds a `nextCursor` field and leaves the
 * unpaginated shape untouched for existing callers.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  let page;
  try {
    page = parsePageRequest(new URL(req.url));
  } catch (err) {
    if (err instanceof InvalidPageError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const store = await getStore();
  const features = await store.listFeatures(authz.scope ?? undefined);

  if (page.limit === null) return Response.json({ features });

  const { items, nextCursor } = paginate(features, (f) => f.specId, page);
  return Response.json({ features: items, nextCursor });
}

/**
 * POST /api/v1/features — create a DB-native work item (initiative/epic). The
 * leaf level comes from spec sync, not this endpoint; the store rejects a leaf
 * level or an invalid parent.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const feature = await createWorkItem(
      parseCreateFeatureInput(body),
      authz.scope ?? undefined,
    );
    for (const path of ["/[org]/[product]/backlog", "/[org]/[product]/roadmap"])
      revalidatePath(path, "page");
    return Response.json({ feature }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof FeatureError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
