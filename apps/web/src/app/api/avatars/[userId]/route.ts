import { eq, userAvatars } from "@specboards/db";

import { getBrowserSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isAvatarMime } from "@/lib/avatars";

export const dynamic = "force-dynamic";

/**
 * GET /api/avatars/:userId - an uploaded profile picture.
 *
 * Outside `/api/v1` on purpose: this is an `<img src>` target, not part of the
 * public API surface, and it answers with bytes rather than JSON.
 *
 * Any signed-in user may fetch any avatar. A tighter rule ("only people who
 * share a workspace with you") is tempting and is not worth its cost: the
 * membership lookup would run on every face on every board, and the thing it
 * would protect is a picture the person chose to show colleagues, whose
 * existence is already implied by the user id in the URL. It is not public,
 * though, so an unauthenticated request gets nothing.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const db = getDb();
  if (!db) return new Response(null, { status: 404 });

  const user = await getBrowserSessionUser(req);
  if (!user) return new Response(null, { status: 401 });

  const { userId } = await params;
  // A malformed id would make Postgres raise on the uuid cast rather than
  // return no rows, so it is turned away before it reaches the query.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return new Response(null, { status: 404 });
  }

  const [row] = await db
    .select({
      bytes: userAvatars.bytes,
      mimeType: userAvatars.mimeType,
      byteSize: userAvatars.byteSize,
      updatedAt: userAvatars.updatedAt,
    })
    .from(userAvatars)
    .where(eq(userAvatars.userId, userId))
    .limit(1);
  if (!row) return new Response(null, { status: 404 });

  // Belt and braces with the CHECK in 0080: whatever is in the column, only a
  // known image type is ever echoed into a Content-Type header.
  const contentType = isAvatarMime(row.mimeType)
    ? row.mimeType
    : "application/octet-stream";

  return new Response(new Uint8Array(row.bytes), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(row.byteSize),
      // The URL carries `?v=<updatedAt>`, so a given URL's bytes never change
      // and can be cached hard. `private` keeps it out of shared caches, since
      // the response needed a session to obtain.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Nothing here is a document, and saying so stops a browser from being
      // talked into treating it as one.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
