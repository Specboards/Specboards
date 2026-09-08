import { mailStatus } from "@/lib/mail/send";
import { isMultiTenant } from "@/lib/tenancy";
import { isNotificationEmailOff } from "@/lib/notification-email";
import {
  getNotificationDefaults,
  getNotificationPreferences,
} from "@/lib/notification-settings-service";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import {
  NotificationDefaultsCard,
  NotificationPreferencesCard,
  type EmailBlock,
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
  const [preferences, defaults, mail, unsubscribed] = await Promise.all([
    getNotificationPreferences(access),
    isAdmin ? getNotificationDefaults(access) : null,
    mailStatus(),
    isNotificationEmailOff(access.userId),
  ]);

  /**
   * Two different reasons the Email column might be dead, and they do not mean
   * the same thing.
   *
   * No transport is a property of the deployment: these rows still say what
   * they will do, they just cannot act yet, so the column keeps showing its
   * resolved value. An unsubscribe is a property of the reader and outranks
   * every row underneath it, so the column has to read as off or the grid is
   * telling them something untrue. The deployment answer comes first because
   * re-subscribing on an install that cannot send would change nothing.
   */
  const own: EmailBlock | null = !mail.configured
    ? { note: "Not configured" }
    : unsubscribed
      ? { note: "You unsubscribed", forcedOff: true }
      : null;
  // The admin grid is workspace policy rather than one person's mail, so an
  // admin who has unsubscribed still sets the defaults everybody else gets.
  const workspace: EmailBlock | null = !mail.configured
    ? { note: "Not configured" }
    : null;
  // On a hosted deployment the transport belongs to whoever runs it, and the
  // mail settings screen is read-only, so there is nowhere here to send an
  // admin who wants one.
  const canConfigureMail = !isMultiTenant();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose what you hear about and where it reaches you.
        </p>
      </div>
      <NotificationPreferencesCard
        rows={preferences.rows}
        emailBlocked={own}
        unsubscribed={unsubscribed}
        mailConfigured={mail.configured}
        canConfigureMail={canConfigureMail}
      />
      {defaults ? (
        <NotificationDefaultsCard
          rows={defaults.rows}
          overrideCounts={defaults.overrideCounts}
          emailBlocked={workspace}
          mailConfigured={mail.configured}
          canConfigureMail={canConfigureMail}
        />
      ) : null}
    </div>
  );
}
