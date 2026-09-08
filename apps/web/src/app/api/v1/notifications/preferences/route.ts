import { authorizeWrite, resolveReadScope } from "@/lib/auth-session";
import {
  getNotificationPreferences,
  parseSettingChanges,
  updateNotificationPreferences,
} from "@/lib/notification-settings-service";
import { NotificationSettingsError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * The caller's own notification settings.
 *
 * GET returns every row the catalog defines, each already resolved through the
 * workspace defaults and tagged with which level decided it, so the grid never
 * has to do the fold itself or ask twice.
 *
 * PATCH applies a set of cells and returns the whole grid back, rather than
 * just an acknowledgement. A cell can move without being touched (an admin
 * changing a default while somebody has the page open), and re-rendering from
 * the response is what keeps "inherited" honest after a save.
 */
export async function GET(req: Request) {
  const authz = await resolveReadScope(req);
  if (!authz.ok) return authz.response;
  return Response.json(
    await getNotificationPreferences(authz.scope ?? undefined),
  );
}

export async function PATCH(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  try {
    const changes = parseSettingChanges(await req.json().catch(() => null));
    return Response.json(
      await updateNotificationPreferences(changes, authz.scope ?? undefined),
    );
  } catch (err) {
    if (err instanceof NotificationSettingsError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
