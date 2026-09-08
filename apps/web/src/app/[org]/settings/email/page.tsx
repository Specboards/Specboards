import { notFound } from "next/navigation";

import { getDb } from "@/lib/db";
import { getMailSettings } from "@/lib/mail-settings-service";
import { isMultiTenant } from "@/lib/tenancy";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { MailSettingsCard } from "@/components/mail-settings";

export const dynamic = "force-dynamic";

/**
 * Mail transport settings.
 *
 * Deployment configuration rather than workspace configuration, which is why
 * it is one card with no tenant scoping and why a multi-tenant install renders
 * it read-only. It lives in Settings anyway because that is where an operator
 * looks, and because the alternative (env only) is what made "configure mail"
 * a redeploy.
 *
 * Owner-gated, and the page says why rather than 404ing: a member who lands
 * here should learn that mail is an admin concern, not that the URL is wrong.
 *
 * A hosted deployment is the exception, and 404s. There the transport belongs
 * to whoever runs the instance: the screen was read-only anyway, the nav does
 * not offer it, and the one thing it would still do is show every workspace
 * owner the deployment's sender address. Not a secret, and not theirs either.
 */
export default async function EmailSettingsPage() {
  if (isMultiTenant()) notFound();

  const access = await requireWorkspaceAccess();
  const db = getDb();

  if (!access || !db) {
    return (
      <p className="text-sm text-muted-foreground">
        Mail settings are unavailable in local file mode.
      </p>
    );
  }
  if (access.role !== "owner") {
    return (
      <p className="text-sm text-muted-foreground">
        Only an organization admin can see or change how this instance sends
        email.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Email</h2>
        <p className="text-sm text-muted-foreground">
          How this instance sends verification links, invitations and
          notifications.
        </p>
      </div>
      <MailSettingsCard initial={await getMailSettings(db)} />
    </div>
  );
}
