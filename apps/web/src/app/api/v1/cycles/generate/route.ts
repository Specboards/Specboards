import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite } from "@/lib/auth-session";
import { generateCycles, parseCycleGenerateInput } from "@/lib/cycles-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { CycleError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/cycles/generate — create a whole run of cycles from a cadence.
 * Body: { startDate, endDate, lengthDays, nameTemplate, startNumber?,
 * productId?, notes? }. `nameTemplate` must contain `{n}`, which carries the
 * sequence number.
 *
 * Only whole cycles are created: a trailing remainder shorter than the cadence
 * is left uncovered rather than emitted as a stunted final cycle.
 *
 * All or nothing. A generated name that collides with an existing cycle aborts
 * the run, so a partially built schedule never reaches the board. Authorization
 * is the same rule as a single create, enforced by the store: admin/contributor
 * for a product cycle, owner for a workspace-wide one.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const cycles = await generateCycles(
      parseCycleGenerateInput(parsed.body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ cycles }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof CycleError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
