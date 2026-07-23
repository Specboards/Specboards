import { readJsonBody } from "@/lib/api/body";
import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  InvalidPatchError,
  createComment,
  listComments,
  parseCommentInput,
} from "@/lib/features-service";
import { CommentError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ specId: string }> };

/** GET /api/v1/features/:specId/comments — comments on the item, oldest first. */
export async function GET(req: Request, { params }: Params) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  try {
    const comments = await listComments(specId, authz.scope ?? undefined);
    return Response.json({ comments });
  } catch (err) {
    if (err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}

/**
 * POST /api/v1/features/:specId/comments — add a comment as the caller. Body:
 * { body, mentionedUserIds? }. Any member who can read the item can comment;
 * the author is taken from the session, never the request body.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { specId } = await params;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const comment = await createComment(
      specId,
      parseCommentInput(body),
      authz.scope ?? undefined,
    );
    return Response.json({ comment }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidPatchError || err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
