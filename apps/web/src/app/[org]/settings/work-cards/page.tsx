import type { ReactNode } from "react";

import { CardsFieldsEditor } from "@/components/cards-fields-editor";
import { CardsScopePicker } from "@/components/cards-scope-picker";
import { CollapsibleSettingsGroup } from "@/components/collapsible-settings-group";
import { DetailTemplatesManager } from "@/components/detail-templates-manager";
import { PropertiesManager } from "@/components/properties-manager";
import { TransitionModeEditor } from "@/components/transition-mode-editor";
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
 * together: the item **Workflow** (the stages/board columns, how items move
 * between them, and the gates guarding each), **Fields** (which built-in fields
 * show per level, plus custom properties), and **Templates** (reusable detail
 * skeletons).
 *
 * Every one of these is configured per product, with a workspace-level default
 * that unconfigured products inherit. `?product=` says which is being edited;
 * without it the page edits the default. That scope lives in the URL rather
 * than in component state so it survives a refresh, is visible in the address
 * bar, and is the same for every panel: the failure mode worth designing
 * against is an admin editing the wrong product's workflow without noticing.
 *
 * Any member sees the configuration. Changing it needs product-admin rights on
 * the product in view, or workspace ownership for the default, matching the
 * /api/v1 write gates and the RLS behind them.
 */
export default async function CardsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const products = await store.listProducts(access ?? undefined);

  const raw = (await searchParams).product;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  // An unknown or no-longer-visible product falls back to the workspace
  // default rather than 404ing: a stale bookmark should land somewhere useful,
  // and it must not confirm that a product the viewer cannot see exists.
  const productId = products.some((p) => p.id === requested)
    ? (requested ?? null)
    : null;

  const [
    levels,
    properties,
    detailTemplates,
    workflow,
    stageGates,
    transitionModes,
    overrides,
  ] = await Promise.all([
    store.listLevels(access ?? undefined, productId),
    store.listProperties(access ?? undefined, undefined, productId),
    store.listDetailTemplates(access ?? undefined, productId),
    resolveWorkflowFor(access, productId),
    store.listStageGates(access ?? undefined, productId),
    store.listTransitionModes(access ?? undefined),
    store.cardsOverrides(access ?? undefined, productId),
  ]);

  const isOwner = !access || access.role === "owner";
  const manageableProductIds = products
    .filter((p) => isOwner || p.viewerRole === "admin")
    .map((p) => p.id);
  // Editing the default is owner-only; editing a product needs admin on THAT
  // product. Both are checked again at the route and in the database.
  const canEdit = productId
    ? manageableProductIds.includes(productId)
    : isOwner;

  // The effective stages the editor starts from (DB-defined, or the built-in
  // default), excluding the system `archived` status.
  const stages = workflow.statuses
    .filter((s) => s !== "archived")
    .map((key, i) => ({ key, label: statusLabel(key, workflow), position: i }));

  return (
    <div className="space-y-8">
      <CardsScopePicker
        products={products}
        active={productId}
        manageableProductIds={manageableProductIds}
        canEditDefault={isOwner}
      />

      <CollapsibleSettingsGroup
        id="workflow"
        title="Workflow"
        description="The stages an item moves through - these are your board columns. Rename a stage in place, reorder, add, or remove stages."
        defaultCollapsed
      >
        <Subsection
          title="Stages"
          description="The board columns items move through. Rename a stage in place, reorder, add, or remove stages."
        >
          <WorkflowEditor
            initial={stages}
            canEdit={canEdit}
            productId={productId}
            overridden={overrides.stages}
          />
        </Subsection>
        <Subsection
          title="Transitions"
          description="How freely items move between the stages above. This governs the board, the API, and agents alike."
        >
          <TransitionModeEditor
            initial={transitionModes}
            productId={productId}
            stages={stages}
            canEdit={canEdit}
          />
        </Subsection>
        <Subsection
          title="Stage gates"
          description="Per-stage checklists that must be completed before an item can advance forward. Members tick them off on the item; an incomplete checklist blocks the move."
        >
          <WorkflowGatesEditor
            stages={stages}
            initial={stageGates}
            canEdit={canEdit}
            productId={productId}
            overridden={overrides.stageGates}
          />
        </Subsection>
      </CollapsibleSettingsGroup>

      <CollapsibleSettingsGroup
        id="fields"
        title="Fields"
        description="What appears on cards: which built-in fields are available per level, and your own custom properties."
        defaultCollapsed
      >
        <Subsection
          title="Built-in fields"
          description="Choose which built-in fields are available on cards at each level. Name, status, parent, and release are always available. Levels themselves are workspace-wide; edit them under Hierarchy."
        >
          <CardsFieldsEditor
            levels={levels}
            catalog={BUILTIN_METADATA_FIELDS}
            canEdit={canEdit}
            productId={productId}
          />
        </Subsection>
        <Subsection
          title="Custom properties"
          description="Define your own fields (text, number, select, date, person, URL…) for work items or releases. For item fields, pick which levels they appear on. Values are edited on each item or release."
        >
          <PropertiesManager
            levels={levels}
            properties={properties}
            canEdit={canEdit}
            productId={productId}
            overridden={overrides.properties}
          />
        </Subsection>
      </CollapsibleSettingsGroup>

      <CollapsibleSettingsGroup
        id="templates"
        title="Templates"
        description="Reusable Markdown skeletons, assigned per level. New cards at that level start from the template, and so do new specs."
        defaultCollapsed
      >
        <DetailTemplatesManager
          levels={levels}
          templates={detailTemplates}
          canEdit={canEdit}
          productId={productId}
          overridden={overrides.detailTemplates}
        />
      </CollapsibleSettingsGroup>
    </div>
  );
}

/** A labeled subsection inside a {@link CollapsibleSettingsGroup}. */
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
