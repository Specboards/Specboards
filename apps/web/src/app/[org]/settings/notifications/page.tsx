import {
  getNotificationDefaults,
  getNotificationPreferences,
} from "@/lib/notification-settings-service";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import {
  NotificationDefaultsCard,
  NotificationPreferencesCard,
} from "@/components/notification-settings";

export const dynamic = "force-dynamic";

/**
 * Notification settings: yours, and (for an admin) the workspace's.
 *
 * This answers the per-user feature's open question about where preferences
 * belong. Settings is the canonical home, because that is where every other
 * configured value lives and because an admin needs their own rows and the
 * defaults behind them on one screen. The notification centre, which is where
 * somebody actually is at the moment they decide a thing is too noisy, links
 * here rather than holding a second copy of the grid.
 *
 * Both grids are rendered on the server so the page arrives showing settings
 * rather than a spinner; every change after that is a client write against the
 * same two endpoints.
 */
export default async function NotificationSettingsPage() {
  const access = await requireWorkspaceAccess();

  // Local file mode has no account and nobody to notify, so there is nothing
  // here to configure. Same treatment as the Profile page.
  if (!access) {
    return (
      <p className="text-sm text-muted-foreground">
        Notification settings are unavailable in local file mode.
      </p>
    );
  }

  const isAdmin = access.role === "owner";
  const [preferences, defaults] = await Promise.all([
    getNotificationPreferences(access),
    isAdmin ? getNotificationDefaults(access) : null,
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose what you hear about and where it reaches you.
        </p>
      </div>
      <NotificationPreferencesCard rows={preferences.rows} />
      {defaults ? (
        <NotificationDefaultsCard
          rows={defaults.rows}
          overrideCounts={defaults.overrideCounts}
        />
      ) : null}
    </div>
  );
}
