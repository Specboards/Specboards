import { resolveReadScope } from "@/lib/auth-session";
import { planItemReleaseCascade } from "@/lib/release-cascade-service";
import { FeatureNotFoundError } from "@/lib/service-errors";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * GET /api/v1/features/:specId/release-cascade?releaseId=<uuid|empty>
 *
 * What cascading that release down from this item would move, without moving
 * anything. Backs the offer made after a release change: no client holds the
 * whole subtree, so a prompt that named a count would be guessing, and the
 * counts here are what the user is being asked to approve.
 *
 * A read, so it is a GET and needs only read scope. Applying is the
 * `?cascadeRelease=1` flag on PATCH ../.
 *
 * An empty or absent `releaseId` means "no release", which always plans
 * nothing: clearing a parent never unschedules the work beneath it.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const raw = new URL(req.url).searchParams.get("releaseId");
  const releaseId = raw === null || raw === "" ? null : raw;
  if (releaseId !== null && !isUuid(releaseId)) {
    return Response.json(
      { error: "releaseId must be a UUID or empty." },
      { status: 422 },
    );
  }

  try {
    const { plan, releaseName } = await planItemReleaseCascade(
      specId,
      releaseId,
      authz.scope ?? undefined,
    );
    return Response.json({
      releaseName,
      moveCount: plan.move.length,
      skippedCount: plan.skipped.length,
      ineligibleCount: plan.ineligible.length,
      depth: plan.depth,
    });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
