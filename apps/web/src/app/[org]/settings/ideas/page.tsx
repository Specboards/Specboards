import type { ReactNode } from "react";

import { resolveIdeaStages } from "@specboards/core";

import { IdeaPortalSettings } from "@/components/idea-portal-settings";
import { IdeaPortalVisibility } from "@/components/idea-portal-visibility";
import { IdeaStagesEditor } from "@/components/idea-stages-editor";
import { resolveWorkflowForProducts } from "@/lib/repo-config";
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
  const [stageRows, settings, products, workflow] = await Promise.all([
    store.listIdeaStatuses(access ?? undefined),
    store.getIdeaSettings(access ?? undefined),
    store.listProducts(access ?? undefined),
    // The union across every product, not one product's workflow: this setting
    // is workspace-wide, so a stage only some products use still has to be
    // offerable. `listStatusesUnion` never hides a stage for exactly this
    // reason.
    resolveWorkflowForProducts(access ?? null, null),
  ]);
  const canEdit = !access || access.role === "owner";
  const stages = resolveIdeaStages(stageRows);
  const titleCase = (key: string) =>
    key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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

      <SettingsGroup
        title="What the portal shows"
        description="Nothing is published until you choose it here. A portal switched on with nothing selected is empty, not broken."
      >
        <IdeaPortalVisibility
          initial={settings}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          ideaStages={stages.map((s) => ({ key: s.key, label: s.label }))}
          itemStatuses={workflow.statuses.map((key) => ({
            key,
            label: workflow.labels?.[key] ?? titleCase(key),
          }))}
          canEdit={canEdit}
        />
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
