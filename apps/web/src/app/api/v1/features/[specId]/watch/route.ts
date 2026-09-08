import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import { getStore } from "@/lib/store";
import { CommentError, type WatchInput } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * Who is watching an item, and the caller's own place on that list.
 *
 * PUT rather than POST/DELETE. The request states what the caller's state
 * should be rather than which way to flip it, so two clicks racing settle on
 * the same answer instead of cancelling out, and a stale button cannot turn a
 * watch off by asking to turn it on.
 *
 * Both verbs answer with the whole state. The watcher list changes when the
 * caller joins or leaves it, and re-rendering from the response keeps the
 * count honest without a second request.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ specId: string }> },
) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const { specId } = await params;
  try {
    const store = await getStore();
    return Response.json(
      await store.listWatchers(specId, authz.scope ?? undefined),
    );
  } catch (err) {
    if (err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ specId: string }> },
) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const { specId } = await params;

  const body = (await req.json().catch(() => null)) as Partial<WatchInput> | null;
  if (typeof body?.watching !== "boolean") {
    return Response.json(
      { error: "`watching` must be true or false." },
      { status: 400 },
    );
  }

  try {
    const store = await getStore();
    return Response.json(
      await store.setWatch(
        specId,
        {
          watching: body.watching,
          includeDescendants: body.includeDescendants === true,
        },
        authz.scope ?? undefined,
      ),
    );
  } catch (err) {
    if (err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
