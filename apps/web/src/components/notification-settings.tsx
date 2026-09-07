"use client";

import {
  updateNotificationDefaults,
  updateNotificationPreferences,
} from "@/lib/api-client/notifications";
import {
  EMAIL_CHANNEL_LIVE,
  type MatrixRow,
} from "@/lib/notifications/matrix";
import { NotificationMatrix } from "@/components/notification-matrix";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The two notification settings surfaces, which are the same grid twice.
 *
 * They sit on one page rather than in two places because the relationship
 * between them is the thing that needs explaining: a member's rows inherit
 * from the workspace's, and an admin who cannot see what their people inherit
 * is setting a default blind. An admin reading this page sees their own
 * settings and the defaults underneath them, in that order, which is also the
 * order the values resolve in.
 *
 * The user's own settings are the first card even for an admin. Far more
 * people arrive here to quieten their own inbox than to set a policy, and the
 * admin card is the one that should take a scroll.
 */

/** Shown when the email channel cannot deliver yet, in both cards. */
function EmailNotYetNote() {
  if (EMAIL_CHANNEL_LIVE) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Email notifications are not switched on yet. The column shows what each
      row will do once they are, and cannot be changed until then.
    </p>
  );
}

export function NotificationPreferencesCard({ rows }: { rows: MatrixRow[] }) {
  return (
    // A named landmark per card. Two grids of identical shape sit on this
    // page, and without a region apiece a screen reader lands in a table of
    // checkboxes with no way to tell whose settings it is reading.
    <Card role="region" aria-label="Your notifications">
      <CardHeader>
        <CardTitle>Your notifications</CardTitle>
        <CardDescription>
          What reaches you, and where. A row you have not changed follows your
          workspace&apos;s default and moves when an admin changes it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <NotificationMatrix
          rows={rows}
          owns="user"
          ownLabel="Your choice"
          inheritedLabel="Workspace default"
          resetTargetLabel="workspace default"
          onSave={async (changes) =>
            (await updateNotificationPreferences(changes)).rows
          }
        />
        <EmailNotYetNote />
      </CardContent>
    </Card>
  );
}

export function NotificationDefaultsCard({
  rows,
  overrideCounts,
}: {
  rows: MatrixRow[];
  overrideCounts: Record<string, Record<string, number>>;
}) {
  return (
    <Card role="region" aria-label="Workspace defaults">
      <CardHeader>
        <CardTitle>Workspace defaults</CardTitle>
        <CardDescription>
          Where everyone in this workspace starts. Changing a default moves
          every member who has not set that row for themselves, so you can
          quieten a noisy notification for the whole workspace without asking
          anyone to go and change a setting. The override counts show which
          defaults people are already departing from.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <NotificationMatrix
          rows={rows}
          owns="workspace"
          ownLabel="Set here"
          inheritedLabel="Built-in default"
          resetTargetLabel="built-in default"
          overrideCounts={overrideCounts}
          onSave={async (changes) =>
            (await updateNotificationDefaults(changes)).rows
          }
        />
        <EmailNotYetNote />
      </CardContent>
    </Card>
  );
}
