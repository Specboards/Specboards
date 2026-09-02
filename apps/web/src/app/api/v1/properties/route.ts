import {
  authorizeCardsWrite,
  readCardsProductId,
} from "@/lib/api/cards-scope";
import { resolveReadScope } from "@/lib/auth-session";
import {
  createProperty,
  listProperties,
  parsePropertyInput,
} from "@/lib/properties-service";
import { InvalidPatchError } from "@/lib/service-errors";
import { revalidateCardPages } from "@/lib/revalidate-cards";
import { PropertyError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/properties — the custom property definitions in force.
 * `?productId=` resolves one product's; without it you get the workspace
 * default. Note this describes what is *defined*, not what items hold: a
 * product that has narrowed its set leaves the dropped values on its items.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const properties = await listProperties(
    authz.scope ?? undefined,
    readCardsProductId(req),
  );
  return Response.json({ properties });
}

/**
 * POST /api/v1/properties — define a custom property (Settings -> Cards).
 * Body: { label, type, options?, levels?, productId? }. With a productId this
 * defines the property on that product (product admins and the workspace
 * owner); without one it defines it on the workspace default (owner only).
 */
export async function POST(req: Request) {
  const authz = await authorizeCardsWrite(req);
  if (!authz.ok) return authz.response;
  const { scope, productId, body } = authz;

  try {
    const property = await createProperty(
      parsePropertyInput(body),
      scope,
      productId,
    );
    revalidateCardPages();
    return Response.json({ property }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof PropertyError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
