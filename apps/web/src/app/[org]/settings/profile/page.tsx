import { eq, users } from "@specboards/db";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { getGithubConnection } from "@/lib/github-user-token";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { GithubAccountCard } from "@/components/github-account-card";
import { AppearanceCard, ProfileCard } from "@/components/settings-form";

export const dynamic = "force-dynamic";

/**
 * Profile settings: picture, name, sign-in email, time zone, appearance
 * (theme), and the connected GitHub account. In local file mode there's no
 * account, so only Appearance (which is device-local) renders.
 *
 * The email is part of the Profile card rather than a card of its own. It is a
 * fact about your identity, and it had been sitting below the GitHub
 * connection, which is a fact about an integration.
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
        email={user.email}
        image={profile?.image ?? null}
        timezone={profile?.timezone ?? null}
      />
      <AppearanceCard />
      <GithubAccountCard connection={connection} orgSlug={access.orgSlug} />
    </div>
  );
}
