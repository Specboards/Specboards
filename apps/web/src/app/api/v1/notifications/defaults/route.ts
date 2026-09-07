import { authorizeOrgAdmin } from "@/lib/auth-session";
import {
  getNotificationDefaults,
  parseSettingChanges,
  updateNotificationDefaults,
} from "@/lib/notification-settings-service";
import { NotificationSettingsError } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/**
 * The workspace's default notification settings.
 *
 * GET is admin-gated even though every member may read the defaults through
 * RLS: a member gets them folded into their own grid on the preferences route,
 * and the extra an admin sees here (how many people have overridden each row)
 * is a fact about other people's settings that no member should be handed.
 *
 * PATCH is admin-only for the same reason it is a workspace setting at all.
 * The store re-checks rather than trusting this, because RLS refuses an
 * unauthorised write by matching no rows rather than by erroring, and a silent
 * success is the one outcome worse than a refusal.
 */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  try {
    return Response.json(await getNotificationDefaults(authz.scope ?? undefined));
  } catch (err) {
    if (err instanceof NotificationSettingsError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
}

export async function PATCH(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  try {
    const changes = parseSettingChanges(await req.json().catch(() => null));
    return Response.json(
      await updateNotificationDefaults(changes, authz.scope ?? undefined),
    );
  } catch (err) {
    if (err instanceof NotificationSettingsError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
