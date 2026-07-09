import type { ReactNode } from "react";

import { resolveIdeaStages } from "@specboard/core";

import { IdeaPortalSettings } from "@/components/idea-portal-settings";
import { IdeaStagesEditor } from "@/components/idea-stages-editor";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Ideas settings: the **Review stages** ideas move through during triage, and
 * the **Public portal** configuration. Any member sees the config; only admins
 * can change it (matching the /api/v1 write gates).
 */
export default async function IdeasSettingsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const [stageRows, settings] = await Promise.all([
    store.listIdeaStatuses(access ?? undefined),
    store.getIdeaSettings(access ?? undefined),
  ]);
  const canEdit = !access || access.role === "owner";
  const stages = resolveIdeaStages(stageRows);

  return (
    <div className="space-y-8">
      <SettingsGroup
        title="Review stages"
        description="The stages an idea moves through during triage (New → Under review → Planned…). Rename in place, reorder, add, or remove stages."
      >
        <IdeaStagesEditor initial={stages} canEdit={canEdit} />
      </SettingsGroup>

      <SettingsGroup
        title="Public portal"
        description="Configure the public voting portal where customers can browse ideas, vote, and submit requests."
      >
        <IdeaPortalSettings initial={settings} canEdit={canEdit} />
      </SettingsGroup>
    </div>
  );
}

/** A titled, bordered settings panel (mirrors the Cards settings layout). */
function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border">
      <div className="border-b px-5 py-4">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-8 p-5">{children}</div>
    </section>
  );
}
