import { authorizeWrite } from "@/lib/auth-session";
import { markAllNotificationsRead } from "@/lib/features-service";

export const dynamic = "force-dynamic";

/** POST /api/v1/notifications/read-all — mark all of the caller's notifications read. */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  await markAllNotificationsRead(authz.scope ?? undefined);
  return Response.json({ ok: true });
}
