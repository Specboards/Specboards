import { authorizeWrite } from "@/lib/auth-session";
import { markNotificationRead } from "@/lib/features-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** POST /api/v1/notifications/:id/read — mark one of the caller's notifications read. */
export async function POST(req: Request, { params }: Params) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const { id } = await params;
  await markNotificationRead(id, authz.scope ?? undefined);
  return Response.json({ ok: true });
}
