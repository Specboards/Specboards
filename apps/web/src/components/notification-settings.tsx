"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  setNotificationEmailSubscription,
  updateNotificationDefaults,
  updateNotificationPreferences,
} from "@/lib/api-client/notifications";
import type { MatrixRow } from "@/lib/notifications/matrix";
import { NotificationMatrix } from "@/components/notification-matrix";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatusLine, type SettingStatus } from "@/components/ui/setting-row";

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

/** Why the email column is dead, when it is. */
export interface EmailBlock {
  note: string;
  forcedOff?: boolean;
}

export function NotificationPreferencesCard({
  rows,
  emailBlocked,
  unsubscribed,
  mailConfigured,
  canConfigureMail,
}: {
  rows: MatrixRow[];
  emailBlocked: EmailBlock | null;
  /** Whether this reader has turned all notification email off. */
  unsubscribed: boolean;
  /** Whether the deployment can send mail at all. */
  mailConfigured: boolean;
  /** Whether an admin here could configure a transport, or the deployment
   * manages it out of reach. */
  canConfigureMail: boolean;
}) {
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
        {/* Above the grid, not below it. Somebody who has unsubscribed needs
            to read that before they spend time ticking a column that is not
            going to do anything.
            Suppressed where the deployment cannot send at all, because then
            nothing is reaching anybody and the column already says so. Two
            explanations for one dead column is one more than helps, and the
            personal one would be the less useful of them. */}
        {unsubscribed && mailConfigured ? <Resubscribe /> : null}
        <NotificationMatrix
          rows={rows}
          owns="user"
          ownLabel="Your choice"
          inheritedLabel="Workspace default"
          resetTargetLabel="workspace default"
          emailBlocked={emailBlocked}
          onSave={async (changes) =>
            (await updateNotificationPreferences(changes)).rows
          }
        />
        {!mailConfigured ? (
          <NoTransportNote canConfigureMail={canConfigureMail} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The way back from an unsubscribe.
 *
 * The card's own control, rather than only the link in the email, because the
 * settings page is where somebody goes when they notice mail has stopped, and
 * an unsubscribe you can only undo from a message you are no longer receiving
 * is a trap. One click, and the per-type choices underneath are exactly as
 * they were left: the switch never touched them.
 */
function Resubscribe() {
  const router = useRouter();
  const [status, setStatus] = useState<SettingStatus>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="status"
      className="space-y-2 rounded-md border border-dashed p-3 text-sm"
    >
      <p>
        You have unsubscribed from all notification email, so nothing in the
        Email column is sending. Your choices there are kept, and turning it
        back on restores them.
      </p>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              try {
                await setNotificationEmailSubscription(true);
                // Re-rendered from the server, because the grid's email column
                // and this whole block are decided there.
                router.refresh();
              } catch (err) {
                setStatus({
                  kind: "error",
                  message:
                    err instanceof Error
                      ? err.message
                      : "Could not turn it back on.",
                });
              }
            });
          }}
        >
          Turn notification email back on
        </Button>
        <StatusLine status={status} />
      </div>
    </div>
  );
}

/**
 * Shown on both cards when the deployment has no way to send mail.
 *
 * Only points at Settings when that is somewhere an admin here can actually
 * do something. On a hosted deployment the transport is the operator\u0027s, not the
 * workspace\u0027s, so sending an admin to a screen they cannot change would be
 * worse than saying nothing.
 */
function NoTransportNote({ canConfigureMail }: { canConfigureMail: boolean }) {
  return (
    <p className="text-xs text-muted-foreground">
      This deployment has no mail transport configured, so nothing in the Email
      column can be delivered.
      {canConfigureMail
        ? " An admin can set one up in Settings \u2192 Email."
        : " That is set by whoever runs this deployment."}
    </p>
  );
}

export function NotificationDefaultsCard({
  rows,
  overrideCounts,
  emailBlocked,
  mailConfigured,
  canConfigureMail,
}: {
  rows: MatrixRow[];
  overrideCounts: Record<string, Record<string, number>>;
  emailBlocked: EmailBlock | null;
  mailConfigured: boolean;
  canConfigureMail: boolean;
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
          emailBlocked={emailBlocked}
          onSave={async (changes) =>
            (await updateNotificationDefaults(changes)).rows
          }
        />
        {!mailConfigured ? (
          <NoTransportNote canConfigureMail={canConfigureMail} />
        ) : null}
        {/* Said on the admin card and not the member one, because it is a
            constraint on what a default can do rather than advice to a reader.
            An admin turning an email row back on for the workspace should not
            expect it to reach somebody who has unsubscribed. */}
        <p className="text-xs text-muted-foreground">
          Anyone who has unsubscribed from notification email receives none of
          it, whatever these defaults say. A default can quieten somebody, and
          it cannot start mailing a person who has asked it to stop.
        </p>
      </CardContent>
    </Card>
  );
}
