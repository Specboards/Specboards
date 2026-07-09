import type { ReactNode } from "react";

import { CardsFieldsEditor } from "@/components/cards-fields-editor";
import { DetailTemplatesManager } from "@/components/detail-templates-manager";
import { PropertiesManager } from "@/components/properties-manager";
import { WorkflowEditor } from "@/components/workflow-editor";
import { WorkflowGatesEditor } from "@/components/workflow-gates-editor";
import { BUILTIN_METADATA_FIELDS } from "@/lib/card-fields";
import { statusLabel } from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Cards settings, grouped into self-contained panels so related controls read
 * together: the item **Workflow** (the stages/board columns), **Fields** (which
 * built-in fields show per level, plus custom properties), and **Templates**
 * (reusable detail skeletons). Any member sees the configuration; only admins
 * can change it (matching the /api/v1 write gates).
 */
export default async function CardsSettingsPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const [levels, properties, detailTemplates, workflow, stageGates] =
    await Promise.all([
      store.listLevels(access ?? undefined),
      store.listProperties(access ?? undefined),
      store.listDetailTemplates(access ?? undefined),
      resolveWorkflowFor(access),
      store.listStageGates(access ?? undefined),
    ]);
  const canEdit = !access || access.role === "owner";

  // The effective stages the editor starts from (DB-defined, or the built-in
  // default), excluding the system `archived` status.
  const stages = workflow.statuses
    .filter((s) => s !== "archived")
    .map((key, i) => ({ key, label: statusLabel(key, workflow), position: i }));

  return (
    <div className="space-y-8">
      <SettingsGroup
        title="Workflow"
        description="The stages an item moves through — these are your board columns. Rename a stage in place, reorder, add, or remove stages."
      >
        <Subsection
          title="Stages"
          description="The board columns items move through. Rename a stage in place, reorder, add, or remove stages."
        >
          <WorkflowEditor initial={stages} canEdit={canEdit} />
        </Subsection>
        <Subsection
          title="Stage gates"
          description="Per-stage checklists that must be completed before an item can advance forward. Members tick them off on the item; an incomplete checklist blocks the move."
        >
          <WorkflowGatesEditor
            stages={stages}
            initial={stageGates}
            canEdit={canEdit}
          />
        </Subsection>
      </SettingsGroup>

      <SettingsGroup
        title="Fields"
        description="What appears on cards: which built-in fields are available per level, and your own custom properties."
      >
        <Subsection
          title="Built-in fields"
          description="Choose which built-in fields are available on cards at each level. Name, status, parent, and release are always available."
        >
          <CardsFieldsEditor
            levels={levels}
            catalog={BUILTIN_METADATA_FIELDS}
            canEdit={canEdit}
          />
        </Subsection>
        <Subsection
          title="Custom properties"
          description="Define your own fields (text, number, select, date, person, URL…) and pick which levels they appear on. Values are edited on each item."
        >
          <PropertiesManager
            levels={levels}
            properties={properties}
            canEdit={canEdit}
          />
        </Subsection>
      </SettingsGroup>

      <SettingsGroup
        title="Templates"
        description="Reusable detail skeletons, assigned per level. New cards at that level start from the template."
      >
        <DetailTemplatesManager
          levels={levels}
          templates={detailTemplates}
          canEdit={canEdit}
        />
      </SettingsGroup>
    </div>
  );
}

/** A titled, bordered settings panel that visually separates one area from the next. */
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

/** A labeled subsection inside a {@link SettingsGroup}. */
function Subsection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
