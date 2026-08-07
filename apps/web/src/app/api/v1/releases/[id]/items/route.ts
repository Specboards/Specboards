import { resolveReadScope } from "@/lib/auth-session";
import {
  groupReleaseItemsByLevel,
  type ReleaseItem,
} from "@/lib/release-items";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/releases/:id/items — the work scheduled into one release, grouped
 * by hierarchy level (top level first).
 *
 * Every level is returned, not just one: the roadmap board draws a single
 * altitude at a time, so this is where a release's full contents are read. The
 * list is scoped to what the caller may read, which is why the response carries
 * its own `count` rather than leaving callers to compare against the release's
 * `itemCount` (that count is workspace-wide and unfiltered).
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const scope = authz.scope ?? undefined;
  const store = await getStore();

  // Confirm the release exists and is readable before listing anything, so an
  // unknown id is a 404 rather than an empty release.
  const releases = await store.listReleases(scope);
  if (!releases.some((r) => r.id === id)) {
    return Response.json({ error: "Release not found." }, { status: 404 });
  }

  const [features, levels] = await Promise.all([
    store.listFeatures(scope),
    store.listLevels(scope),
  ]);

  const items: ReleaseItem[] = features
    .filter((f) => f.releaseId === id)
    .map((f) => ({
      specId: f.specId,
      title: f.title,
      level: f.level,
      status: f.status,
      productId: f.productId,
    }));

  return Response.json({
    groups: groupReleaseItemsByLevel(items, levels),
    count: items.length,
  });
}
