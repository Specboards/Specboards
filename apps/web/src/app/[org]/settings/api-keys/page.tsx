import { listApiKeys } from "@/lib/api-keys";
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { ApiKeysCard } from "@/components/api-keys-card";

export const dynamic = "force-dynamic";

/**
 * Personal API keys for the SpecBoard CLI and other programmatic access. Each
 * key acts as you, inheriting your workspace role. Unavailable in local file
 * mode (no accounts). The plaintext key is shown once, at creation.
 */
export default async function ApiKeysSettingsPage() {
  const access = await requireWorkspaceAccess();
  const db = getDb();
  const user = await getServerSessionUser();

  if (!access || !db || !user) {
    return (
      <p className="text-sm text-muted-foreground">
        API keys are unavailable in local file mode.
      </p>
    );
  }

  const keys = await listApiKeys(db, user.id);
  // Dates are not serializable across the server/client boundary as Date; the
  // card renders ISO strings.
  const initialKeys = keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  }));

  return <ApiKeysCard initialKeys={initialKeys} />;
}
