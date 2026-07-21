import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createRelease,
  listReleases,
  parseReleaseInput,
} from "@/lib/features-service";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { ReleaseError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/releases — the workspace's releases (dated first, undated last).
 * Full list by default; pass `?limit` for opt-in cursor pagination (adds
 * `nextCursor`, preserves the dated-first order).
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

  const releases = await listReleases(authz.scope ?? undefined);
  if (page.limit === null) return Response.json({ releases });

  const { items, nextCursor } = paginate(releases, (r) => r.id, page);
  return Response.json({ releases: items, nextCursor });
}

/**
 * POST /api/v1/releases — create a release. Body: { name, productId?, status?,
 * startDate?, targetDate?, notes? }. Per-product authorization is enforced by
 * the store: admin/contributor for a product release, owner for a portfolio
 * (null-product) release. Local file mode is ungated.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const release = await createRelease(
      parseReleaseInput(body),
      authz.scope ?? undefined,
    );
    revalidateCardPages();
    return Response.json({ release }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof ReleaseError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
