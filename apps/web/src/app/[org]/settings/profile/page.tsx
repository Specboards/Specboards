import { eq, users } from "@specboards/db";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubConnection } from "@/lib/github-user-token";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { GithubAccountCard } from "@/components/github-account-card";
import { AppearanceCard, EmailCard, ProfileCard } from "@/components/settings-form";

export const dynamic = "force-dynamic";

/**
 * Profile settings: name, picture, time zone, appearance (theme), and the
 * sign-in email. In local file mode there's no account, so only Appearance
 * (which is device-local) renders.
 */
export default async function ProfileSettingsPage() {
  const access = await requireWorkspaceAccess();
  const db = getDb();
  const user = await getServerSessionUser();

  if (!access || !db || !user) {
    return (
      <div className="space-y-6">
        <AppearanceCard />
        <p className="text-sm text-muted-foreground">
          Account settings are unavailable in local file mode.
        </p>
      </div>
    );
  }

  const [[profile], connection] = await Promise.all([
    db
      .select({ image: users.image, timezone: users.timezone })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1),
    getGithubConnection(db, access.workspaceId, user.id),
  ]);

  return (
    <div className="space-y-6">
      <ProfileCard
        name={user.name}
        image={profile?.image ?? null}
        timezone={profile?.timezone ?? null}
      />
      <AppearanceCard />
      <GithubAccountCard connection={connection} orgSlug={access.orgSlug} />
      <EmailCard email={user.email} />
    </div>
  );
}
