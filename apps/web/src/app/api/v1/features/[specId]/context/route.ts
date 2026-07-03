import { resolveReadAccess } from "@/lib/auth-session";
import { getItemDetailData } from "@/lib/item-detail";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * GET /api/v1/features/:specId/context — the full item-detail bundle (metadata,
 * properties, releases, workflow, hierarchy labels, parent/relation candidates,
 * and the caller's edit rights). Backs the flyout so it renders the exact same
 * layout as the full item page from a single round-trip.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadAccess(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const data = await getItemDetailData(specId, authz.access);
  if (!data) {
    return Response.json({ error: `Unknown feature: ${specId}` }, { status: 404 });
  }
  return Response.json({ data });
}
