import { resolveReadScope } from "@/lib/auth-session";
import {
  listNotifications,
  parseNotificationQuery,
} from "@/lib/notifications-service";
import { CommentError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/notifications - a page of the caller's inbox, newest first, plus
 * their unread total.
 *
 * Query: `unread=1`, repeated `type=`, `product=<key>`, `limit=`, `before=`
 * (an ISO timestamp cursor from a previous response's `nextCursor`). No
 * parameters returns the newest page unfiltered, which is what the bell asks
 * for and what every caller before this got.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const query = parseNotificationQuery(new URL(req.url).searchParams);
  try {
    const inbox = await listNotifications(authz.scope ?? undefined, query);
    return Response.json(inbox);
  } catch (err) {
    // A malformed cursor is the caller's mistake, not a server fault.
    if (err instanceof CommentError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
