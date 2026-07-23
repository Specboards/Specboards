import { revalidatePath } from "next/cache";

import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  FeatureNotFoundError,
  listGateCompletions,
  setGateCompletion,
} from "@/lib/features-service";
import { getStore } from "@/lib/store";
import { StageGateError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** GET /api/v1/features/:specId/gates - the gate ids checked off for the item. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const store = await getStore();
  const feature = await store.getFeature(specId, authz.scope ?? undefined);
  if (!feature) {
    return Response.json(
      { error: `Unknown feature: ${specId}` },
      { status: 404 },
    );
  }
  const completed = await listGateCompletions(specId, authz.scope ?? undefined);
  return Response.json({ completed });
}

/**
 * PUT /api/v1/features/:specId/gates - check/uncheck one gate for the item
 * ({ gateId, completed }). Returns the refreshed set of completed gate ids.
 */
export async function PUT(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const raw = body as { gateId?: unknown; completed?: unknown };
  if (typeof raw.gateId !== "string" || !raw.gateId) {
    return Response.json({ error: "gateId is required." }, { status: 422 });
  }
  if (typeof raw.completed !== "boolean") {
    return Response.json(
      { error: "completed must be a boolean." },
      { status: 422 },
    );
  }

  try {
    const completed = await setGateCompletion(
      specId,
      raw.gateId,
      raw.completed,
      authz.scope ?? undefined,
    );
    revalidatePath("/[org]/[product]/backlog/[...slug]", "page");
    return Response.json({ completed });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof StageGateError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
