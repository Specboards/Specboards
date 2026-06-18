import { HierarchyEditor } from "@/components/hierarchy-editor";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Hierarchy settings: edit the workspace's work-tracking levels (e.g.
 * Initiative → Epic → Feature). Any member sees the levels; only admins can
 * change them (matching the PUT /api/v1/levels authorization).
 */
export default async function HierarchySettingsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const levels = await store.listLevels(access ?? undefined);
  const canEdit = !access || access.role === "admin";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Hierarchy</h2>
        <p className="text-sm text-muted-foreground">
          Choose your work-tracking levels and how deep your hierarchy goes.
        </p>
      </div>
      <HierarchyEditor levels={levels} canEdit={canEdit} />
    </div>
  );
}
