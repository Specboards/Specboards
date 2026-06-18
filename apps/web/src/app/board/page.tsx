import { parentLevelKey, resolveEstimateConfig, resolveWorkflow } from "@specboard/core";

import { BoardClient } from "@/app/board/board-client";
import { CardFieldsMenu } from "@/components/card-fields-menu";
import { EmptyState } from "@/components/empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import { WorkItemCreate } from "@/components/work-item-create";
import { WorkViewTabs } from "@/components/work-view-tabs";
import { resolveActiveLevel } from "@/lib/active-level";
import { getBoardPreferences } from "@/lib/board-preferences-service";
import { cardFieldCatalog, resolveCardFields } from "@/lib/card-fields";
import { getDb } from "@/lib/db";
import { resolveRepoConfig } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { canWrite, listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Kanban board: drag cards to reorder / change status, click to edit inline. */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);

  const repoConfig = await resolveRepoConfig(access);
  const workflow = resolveWorkflow(repoConfig);
  const estimate = resolveEstimateConfig(repoConfig);
  const customFields = repoConfig?.fields ?? [];
  const columns = workflow.statuses.filter((s) => s !== "archived");

  const store = await getStore();
  const allFeatures = await store.listFeatures(access ?? undefined);

  // The board shows one hierarchy level at a time (default: the leaf/specs).
  const levels = await store.listLevels(access ?? undefined);
  const activeLevel = resolveActiveLevel(levels, (await searchParams).level);
  const features = allFeatures.filter((f) => f.level === activeLevel.key);
  const parentKey = parentLevelKey(activeLevel.key, levels);
  const parents = parentKey
    ? allFeatures
        .filter((f) => f.level === parentKey)
        .map((f) => ({ specId: f.specId, title: f.title }))
    : [];
  const parentLabel =
    levels.find((l) => l.key === parentKey)?.label ?? null;

  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const memberNames = Object.fromEntries(members.map((m) => [m.userId, m.name]));

  const prefs = await getBoardPreferences(access ?? undefined);
  const catalog = cardFieldCatalog(customFields);
  const { fields: cardFields, featured } = resolveCardFields(prefs, catalog);
  const customFieldLabels = Object.fromEntries(
    customFields.map((f) => [f.key, f.label]),
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <WorkViewTabs />
          <LevelSwitcher levels={levels} active={activeLevel.key} />
        </div>
        <div className="flex items-center gap-2">
          {canEdit && !activeLevel.isLeaf ? (
            <WorkItemCreate
              levelKey={activeLevel.key}
              levelLabel={activeLevel.label}
              parentLabel={parentLabel}
              parents={parents}
            />
          ) : null}
          {features.length > 0 && canEdit ? (
            <CardFieldsMenu
              catalog={catalog}
              customFields={customFields.map((f) => ({ key: f.key, label: f.label }))}
              selected={cardFields}
              featured={featured}
            />
          ) : null}
        </div>
      </div>
      {features.length === 0 ? (
        activeLevel.isLeaf ? (
          <EmptyState canConnect={canConnectRepos(access)} />
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No {activeLevel.label.toLowerCase()} items yet.
            {canEdit ? ` Use “New ${activeLevel.label.toLowerCase()}” to add one.` : ""}
          </p>
        )
      ) : (
        <BoardClient
          features={features}
          parentCandidates={parents}
          columns={columns}
          workflow={workflow}
          canEdit={canEdit}
          cardFields={cardFields}
          featured={featured}
          customFieldLabels={customFieldLabels}
          memberNames={memberNames}
          members={members}
          customFields={customFields}
          estimate={estimate}
        />
      )}
    </section>
  );
}
