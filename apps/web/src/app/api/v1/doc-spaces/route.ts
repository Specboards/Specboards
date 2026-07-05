import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  getDocSpace,
  parseDocArea,
  parseDocSpaceInput,
  setDocSpace,
} from "@/lib/docs-service";
import { DocError, ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/doc-spaces?productId=&area= - where the area's docs live.
 * Returns mode `unset` when the team hasn't chosen a source yet.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  try {
    const space = await getDocSpace(
      url.searchParams.get("productId") ?? "",
      parseDocArea(url.searchParams.get("area")),
      authz.scope ?? undefined,
    );
    return Response.json({ space });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * PUT /api/v1/doc-spaces - choose (or change) an area's doc source. Body:
 * { productId, area, mode, externalUrl?, repoId? }. Requires product write.
 */
export async function PUT(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const { productId, area, input } = parseDocSpaceInput(body);
    const space = await setDocSpace(productId, area, input, authz.scope ?? undefined);
    return Response.json({ space });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
