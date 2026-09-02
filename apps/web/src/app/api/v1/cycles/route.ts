import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { createCycle, listCycles, parseCycleInput } from "@/lib/cycles-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { CycleError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/cycles — the workspace's cycles (sprints / iterations), ordered
 * active first, then upcoming by soonest start, then most recently complete.
 * Each carries a derived `state` (upcoming/active/complete) computed from its
 * dates rather than stored, so it is never stale. Full list by default; pass
 * `?limit` for opt-in cursor pagination.
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

  const cycles = await listCycles(authz.scope ?? undefined);
  if (page.limit === null) return Response.json({ cycles });

  const { items, nextCursor } = paginate(cycles, (c) => c.id, page);
  return Response.json({ cycles: items, nextCursor });
}

/**
 * POST /api/v1/cycles — create a cycle. Body: { name, startDate, endDate,
 * productId?, notes? }. Per-product authorization is enforced by the store:
 * admin/contributor for a product cycle, owner for a workspace-wide
 * (null-product) one. Local file mode is ungated.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;

  try {
    const cycle = await createCycle(
      parseCycleInput(parsed.body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ cycle }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof CycleError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
