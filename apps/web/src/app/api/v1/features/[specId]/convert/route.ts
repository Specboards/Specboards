import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { convertItem, previewConversion } from "@/lib/convert-item-service";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";
import { FeatureError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/**
 * GET /api/v1/features/:specId/convert?to=epic — what converting would do.
 *
 * A read, because it writes nothing and the UI asks it every time the target
 * level changes in the picker. The plan it returns is the same one the POST
 * enforces, so what somebody confirmed is what happens.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const to = new URL(req.url).searchParams.get("to");
  if (!to) {
    return Response.json(
      { error: "A target level is required: ?to=<level key>." },
      { status: 400 },
    );
  }

  try {
    const plan = await previewConversion(specId, to, authz.scope ?? undefined);
    return Response.json({ plan });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

/**
 * POST /api/v1/features/:specId/convert — change the item's level. Body:
 * { to }.
 *
 * 422 with every blocker in one message when the conversion is refused, so a
 * caller that fixes one thing is not sent round again for the next.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const to =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).to
      : undefined;
  if (typeof to !== "string" || to === "") {
    return Response.json(
      { error: "A target level is required: { to: <level key> }." },
      { status: 400 },
    );
  }

  try {
    const feature = await convertItem(specId, to, authz.scope ?? undefined);
    return Response.json({ feature });
  } catch (err) {
    if (err instanceof FeatureNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidPatchError || err instanceof FeatureError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
