import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { rolloverCycle } from "@/lib/cycles-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { CycleError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/cycles/:id/rollover — move this cycle's unfinished work into
 * another cycle. Body: { toCycleId }.
 *
 * Deliberately an explicit action rather than something that happens when a
 * cycle's end date passes. What carries over is a planning decision the team
 * makes when they close a cycle, and anything automatic would be wrong as often
 * as right. Items already done (or archived) stay put, so the finished cycle
 * keeps an honest record of what it delivered.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const body = parsed.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InvalidPatchError("Request body must be a JSON object.");
    }
    const toCycleId = (body as Record<string, unknown>).toCycleId;
    if (typeof toCycleId !== "string" || !toCycleId) {
      throw new InvalidPatchError("toCycleId is required.");
    }
    const result = await rolloverCycle(id, toCycleId, authz.scope ?? undefined);
    revalidateCardPages();
    return Response.json(result);
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof CycleError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
