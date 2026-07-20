import { authorizeWrite } from "@/lib/auth-session";
import { deleteComment } from "@/lib/features-service";
import { CommentError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ commentId: string }> };

/**
 * DELETE /api/v1/comments/:commentId — remove a comment. Only its author or the
 * workspace owner may delete it (enforced by the store).
 */
export async function DELETE(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;

  const { commentId } = await params;
  try {
    await deleteComment(commentId, authz.scope ?? undefined);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
