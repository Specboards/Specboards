import { revalidatePath } from "next/cache";

import {
  authorizeCardsWrite,
  readCardsProductId,
} from "@/lib/api/cards-scope";
import { resolveReadScope } from "@/lib/auth-session";
import { InvalidPatchError } from "@/lib/service-errors";
import {
  listStageGates,
  parseStageGates,
  replaceStageGates,
} from "@/lib/workflow-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/stage-gates - the stage gates in force ([] = none defined).
 * `?productId=` resolves one product's; without it you get the workspace
 * default that unconfigured products inherit.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const gates = await listStageGates(
    authz.scope ?? undefined,
    readCardsProductId(req),
  );
  return Response.json({ gates });
}

/**
 * PUT /api/v1/stage-gates - replace a product's stage gates, or the workspace
 * default's when `productId` is omitted. Gates block every member's
 * transitions and a full replace resets per-item checklist progress for the
 * gates it removes, so writing needs product-admin rights (or workspace
 * ownership for the default). Local file mode is ungated.
 *
 * An empty list is how a product goes back to inheriting: it owns no gate rows
 * again, so resolution falls through to the workspace default.
 */
export async function PUT(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const gates = await replaceStageGates(
      parseStageGates(body),
      scope,
      productId,
    );
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
