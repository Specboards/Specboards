import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  createDocPage,
  listDocPages,
  parseDocArea,
  parseDocPageInput,
} from "@/lib/docs-service";
import { DocError, ProductError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** GET /api/v1/docs?productId=&area= - the area's folders and pages. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  try {
    const pages = await listDocPages(
      url.searchParams.get("productId") ?? "",
      parseDocArea(url.searchParams.get("area")),
      authz.scope ?? undefined,
    );
    return Response.json({ pages });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}

/**
 * POST /api/v1/docs - create a folder or page. Body: { productId, area,
 * title, kind?, parentId?, content? }. Requires product write.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const page = await createDocPage(
      parseDocPageInput(body),
      authz.scope ?? undefined,
    );
    return Response.json({ page }, { status: 201 });
  } catch (err) {
    if (err instanceof DocError || err instanceof ProductError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
