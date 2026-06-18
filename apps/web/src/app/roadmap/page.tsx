import Link from "next/link";

import { parentLevelKey } from "@specboard/core";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { LevelSwitcher } from "@/components/level-switcher";
import { StatusDot } from "@/components/status-dot";
import { WorkItemCreate } from "@/components/work-item-create";
import { resolveActiveLevel } from "@/lib/active-level";
import {
  priorityLabel,
  sortFeatures,
  statusLabel,
} from "@/lib/feature-helpers";
import { getStore } from "@/lib/store";
import { canWrite } from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Roadmap: features grouped by quarter, unscheduled work last. */
export default async function RoadmapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);
  const store = await getStore();
  const allFeatures = sortFeatures(
    await store.listFeatures(access ?? undefined),
  ).filter((f) => f.status !== "archived");

  // Roadmap shows one hierarchy level at a time (default: the leaf/specs).
  const levels = await store.listLevels(access ?? undefined);
  const activeLevel = resolveActiveLevel(levels, (await searchParams).level);
  const features = allFeatures.filter((f) => f.level === activeLevel.key);
  const parentKey = parentLevelKey(activeLevel.key, levels);
  const parents = parentKey
    ? allFeatures
        .filter((f) => f.level === parentKey)
        .map((f) => ({ specId: f.specId, title: f.title }))
    : [];
  const parentLabel = levels.find((l) => l.key === parentKey)?.label ?? null;

  const quarters = [
    ...new Set(
      features.flatMap((f) => (f.roadmapQuarter ? [f.roadmapQuarter] : [])),
    ),
  ].sort();
  const groups: Array<{ label: string; quarter: string | null }> = [
    ...quarters.map((q) => ({ label: q, quarter: q as string | null })),
    { label: "Unscheduled", quarter: null },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Roadmap</h1>
          <LevelSwitcher levels={levels} active={activeLevel.key} />
        </div>
        {canEdit && !activeLevel.isLeaf ? (
          <WorkItemCreate
            levelKey={activeLevel.key}
            levelLabel={activeLevel.label}
            parentLabel={parentLabel}
            parents={parents}
          />
        ) : null}
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groups.map(({ label, quarter }) => {
          const items = features.filter((f) => f.roadmapQuarter === quarter);
          return (
            <div key={label} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                {label}
              </h2>
              {items.map((f) => (
                <Card key={f.specId} className="rounded-lg shadow-none">
                  <CardHeader className="space-y-1 p-3">
                    <CardTitle className="text-sm">
                      <Link
                        href={`/feature/${f.specId}`}
                        className="hover:underline"
                      >
                        {f.title}
                      </Link>
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <StatusDot status={f.status} />
                      {statusLabel(f.status)}
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px]"
                      >
                        {priorityLabel(f.priority)}
                      </Badge>
                    </CardDescription>
                  </CardHeader>
                </Card>
              ))}
              {items.length === 0 && (
                <p className="text-xs text-muted-foreground">Empty</p>
              )}
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
