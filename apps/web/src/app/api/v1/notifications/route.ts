import { resolveReadScope } from "@/lib/auth-session";
import { listNotifications } from "@/lib/features-service";

export const dynamic = "force-dynamic";

/** GET /api/v1/notifications — the caller's inbox (newest first) + unread count. */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  const inbox = await listNotifications(authz.scope ?? undefined);
  return Response.json(inbox);
}
