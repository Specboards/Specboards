import { readJsonBody } from "@/lib/api/body";
import { resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  parseIdeaVote,
  setIdeaVote,
} from "@/lib/features-service";
import { revalidateIdeaPages } from "@/lib/revalidate-cards";
import { IdeaError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/ideas/:id/vote - set the caller's vote on an idea. Body:
 * { voted: boolean }. Any workspace member can vote (demand signal), so this
 * uses read scope rather than a write role.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const idea = await setIdeaVote(
      id,
      parseIdeaVote(body),
      authz.scope ?? undefined,
    );
    revalidateIdeaPages();
    return Response.json({ idea });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof IdeaError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
