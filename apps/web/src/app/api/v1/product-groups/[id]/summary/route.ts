import { resolveReadScope } from "@/lib/auth-session";
import { getGroupSummary } from "@/lib/product-groups-service";
import { GroupError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/product-groups/:id/summary — the group's roll-up: direct
 * subgroups plus per-product item counts, status breakdowns, and release
 * progress over the readable products in its subtree.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;

  try {
    const summary = await getGroupSummary(id, authz.scope ?? undefined);
    return Response.json({ summary });
  } catch (err) {
    if (err instanceof GroupError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
