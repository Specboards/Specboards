import { getDb } from "@/lib/db";
import { getStore } from "@/lib/store";
import { listWorkspaceMembers, getWorkspaceById } from "@/lib/workspace";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { CompanyCard } from "@/components/settings-form";
import { OrgMembers } from "@/components/org-members";
import type { OrgMemberRecord } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** Organization details plus the Team roster (list, roles, invites, deactivate). */
export default async function CompanySettingsPage() {
  const access = await requireWorkspaceAccess();
  const db = getDb();

  if (!access || !db) {
    return (
      <p className="text-sm text-muted-foreground">
        Company settings are unavailable in local file mode.
      </p>
    );
  }

  const store = await getStore();
  const [workspace, roster, products] = await Promise.all([
    getWorkspaceById(db, access.workspaceId),
    listWorkspaceMembers(db, access.workspaceId),
    store.listProducts(access),
  ]);

  const members: OrgMemberRecord[] = roster.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    deactivatedAt: m.deactivatedAt ? m.deactivatedAt.toISOString() : null,
  }));

  return (
    <div className="space-y-8">
      <CompanyCard name={workspace?.name ?? ""} canEdit={access.role === "owner"} />
      <OrgMembers
        initialMembers={members}
        currentUserId={access.userId}
        canManage={access.role === "owner"}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  );
}
