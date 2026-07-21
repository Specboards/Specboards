import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createIdea,
  listIdeas,
  parseIdeaInput,
} from "@/lib/features-service";
import { InvalidPageError, paginate, parsePageRequest } from "@/lib/pagination";
import { revalidateIdeaPages } from "@/lib/revalidate-cards";
import { IdeaError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/ideas - the workspace's ideas the caller can see, most-voted
 * first. Full list by default; pass `?limit` for opt-in cursor pagination
 * (adds `nextCursor`, preserves the most-voted order).
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

  const ideas = await listIdeas(authz.scope ?? undefined);
  if (page.limit === null) return Response.json({ ideas });

  const { items, nextCursor } = paginate(ideas, (i) => i.id, page);
  return Response.json({ ideas: items, nextCursor });
}

/**
 * POST /api/v1/ideas - capture an idea. Body: { title, description?,
 * productId? }. Requires a non-viewer member; local file mode is ungated.
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
    const idea = await createIdea(parseIdeaInput(body), authz.scope ?? undefined);
    revalidateIdeaPages();
    return Response.json({ idea }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof IdeaError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
