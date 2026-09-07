import { authorizeWrite } from "@/lib/auth-session";
import { markNotificationUnread } from "@/lib/notifications-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/notifications/:id/unread - put one back on the pile.
 *
 * The counterpart to marking read. Opening a row is how you read it, so
 * without this the inbox loses anything clicked by accident or seen at a
 * moment when it could not be acted on.
 */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  await markNotificationUnread(id, authz.scope ?? undefined);
  return Response.json({ ok: true });
}
