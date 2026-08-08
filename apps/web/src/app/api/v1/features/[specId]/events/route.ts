import { resolveReadScope } from "@/lib/auth-session";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** Bounded so one very active item cannot return an unbounded page. */
const MAX_EVENTS = 200;
const DEFAULT_EVENTS = 50;

/**
 * GET /api/v1/features/:specId/events - the item's change history, newest first.
 *
 * Read-only by design. History is appended by the writes that cause it, so
 * there is no POST here and never should be: an endpoint that lets a caller
 * author history entries makes the record worth less than not having one.
 *
 * An item the caller cannot read returns an empty list rather than a 404, which
 * is what the store's product-visibility check already produces. There is
 * nothing to distinguish here: "no history" and "not yours to see" should look
 * the same from outside.
 */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const requested = Number(new URL(req.url).searchParams.get("limit"));
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_EVENTS)
      : DEFAULT_EVENTS;

  const store = await getStore();
  const events = await store.listItemEvents(specId, authz.scope ?? undefined, limit);
  return Response.json({ events });
}
