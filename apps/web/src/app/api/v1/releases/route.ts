import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createRelease,
  listReleases,
  parseReleaseInput,
} from "@/lib/features-service";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { ReleaseError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/releases — the workspace's releases (dated first, undated last). */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const releases = await listReleases(authz.scope ?? undefined);
  return Response.json({ releases });
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
